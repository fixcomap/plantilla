package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"

	"golang.org/x/image/font"
	"golang.org/x/image/font/gofont/gobold"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"
	"golang.org/x/image/vector"
)

// Imagen de la pizarra para compartirla (WhatsApp…). Se genera aquí y no en el
// navegador: la app instalada en iPhone no descarga blobs. Mismo dibujo que
// board.js: campo vertical de 68 x 105 m con la portería propia abajo.

const (
	bxScale  = 10.0 // píxeles por metro
	bxMargin = 30.0
	bxHead   = 74.0 // franja del título
)

var boldFont = func() *opentype.Font {
	f, err := opentype.Parse(gobold.TTF)
	if err != nil {
		panic(err)
	}
	return f
}()

// shape acumula polígonos de un mismo color y los rellena de una vez. Todos
// se generan con la misma orientación, así que los solapes no se anulan.
type shape struct{ polys [][][2]float64 }

func (s *shape) poly(pts ...[2]float64) { s.polys = append(s.polys, pts) }

func (s *shape) circle(cx, cy, r float64) {
	pts := make([][2]float64, 48)
	for i := range pts {
		a := 2 * math.Pi * float64(i) / 48
		pts[i] = [2]float64{cx + r*math.Cos(a), cy + r*math.Sin(a)}
	}
	s.poly(pts...)
}

// line: segmento de grosor w como rectángulo, con media anchura de
// prolongación en los extremos para que las uniones no dejen huecos.
func (s *shape) line(a, b [2]float64, w float64) {
	dx, dy := b[0]-a[0], b[1]-a[1]
	l := math.Hypot(dx, dy)
	if l == 0 {
		return
	}
	ux, uy := dx/l*w/2, dy/l*w/2
	nx, ny := -uy, ux
	a = [2]float64{a[0] - ux, a[1] - uy}
	b = [2]float64{b[0] + ux, b[1] + uy}
	s.poly([2]float64{a[0] + nx, a[1] + ny}, [2]float64{b[0] + nx, b[1] + ny},
		[2]float64{b[0] - nx, b[1] - ny}, [2]float64{a[0] - nx, a[1] - ny})
}

func (s *shape) polyline(pts [][2]float64, w float64) {
	for i := 1; i < len(pts); i++ {
		s.line(pts[i-1], pts[i], w)
	}
}

func (s *shape) ring(cx, cy, r, w float64) {
	pts := make([][2]float64, 73)
	for i := range pts {
		a := 2 * math.Pi * float64(i) / 72
		pts[i] = [2]float64{cx + r*math.Cos(a), cy + r*math.Sin(a)}
	}
	s.polyline(pts, w)
}

func (s *shape) rect(x, y, w, h, lw float64) {
	s.polyline([][2]float64{{x, y}, {x + w, y}, {x + w, y + h}, {x, y + h}, {x, y}}, lw)
}

func (s *shape) draw(dst *image.RGBA, c color.Color) {
	b := dst.Bounds()
	z := vector.NewRasterizer(b.Dx(), b.Dy())
	for _, p := range s.polys {
		z.MoveTo(float32(p[0][0]), float32(p[0][1]))
		for _, q := range p[1:] {
			z.LineTo(float32(q[0]), float32(q[1]))
		}
		z.ClosePath()
	}
	z.Draw(dst, b, image.NewUniform(c), image.Point{})
}

// wavePoints: flecha ondulada (conducción). Mismo cálculo que board.js.
func wavePoints(a, b BoardPoint) []BoardPoint {
	dx, dy := b.X-a.X, b.Y-a.Y
	l := math.Hypot(dx, dy)
	if l < 4 {
		return []BoardPoint{a, b}
	}
	ux, uy := dx/l, dy/l
	var out []BoardPoint
	for s := 0.0; s <= l-2; s += .25 {
		o := math.Sin(s/3*2*math.Pi) * .8
		out = append(out, BoardPoint{a.X + ux*s - uy*o, a.Y + uy*s + ux*o})
	}
	return append(out, b)
}

func rgba(c [3]float64) color.RGBA {
	return color.RGBA{uint8(c[0]*255 + .5), uint8(c[1]*255 + .5), uint8(c[2]*255 + .5), 255}
}

func mix(a, b [3]float64, t float64) [3]float64 {
	return [3]float64{a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, a[2] + (b[2]-a[2])*t}
}

func renderBoard(b Board, t Team, step int) ([]byte, error) {
	team := parseHex("#1d6b45")
	if hexColor.MatchString(t.Color) {
		team = parseHex(t.Color)
	}
	bg, fg := [3]float64{.953, .945, .922}, [3]float64{.098, .106, .09}
	teamFg := color.RGBA{255, 255, 255, 255}
	if contrast(team, [3]float64{1, 1, 1}) < 3 {
		teamFg = color.RGBA{17, 17, 17, 255}
	}
	ink := toward(team, [3]float64{}, bg)

	w := int(pitchW*bxScale + 2*bxMargin)
	h := int(pitchL*bxScale + 2*bxMargin + bxHead)
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.Draw(img, img.Bounds(), image.NewUniform(rgba(bg)), image.Point{}, draw.Src)
	// Metros del campo → píxeles.
	px := func(x, y float64) [2]float64 {
		return [2]float64{bxMargin + x*bxScale, bxMargin + bxHead + y*bxScale}
	}
	pp := func(p BoardPoint) [2]float64 { return px(p.X, p.Y) }

	face := func(size float64) (font.Face, error) {
		return opentype.NewFace(boldFont, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
	}
	text := func(s string, size float64, c color.Color, x, y float64, center bool) error {
		f, err := face(size)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		d := font.Drawer{Dst: img, Src: image.NewUniform(c), Face: f}
		if center {
			x -= float64(d.MeasureString(s)) / 64 / 2
		}
		d.Dot = fixed.P(int(x), int(y))
		d.DrawString(s)
		return nil
	}

	// Título: nombre de la pizarra y equipo (con el paso si hay varios).
	sub := t.Name
	if n := len(b.State.Steps) + 1; n > 1 {
		sub = fmt.Sprintf("%s · paso %d de %d", t.Name, min(step+1, n), n)
	}
	if err := text(b.Name, 30, rgba(fg), bxMargin, bxMargin+24, false); err != nil {
		return nil, err
	}
	if err := text(sub, 16, rgba(mix(fg, bg, .45)), bxMargin, bxMargin+50, false); err != nil {
		return nil, err
	}

	// Campo.
	var grass, lines, spots shape
	o := px(0, 0)
	grass.poly(o, px(pitchW, 0), px(pitchW, pitchL), px(0, pitchL))
	grass.draw(img, rgba(mix(bg, team, .07)))
	lw := .3 * bxScale
	lines.rect(o[0], o[1], pitchW*bxScale, pitchL*bxScale, lw)
	lines.line(px(0, pitchL/2), px(pitchW, pitchL/2), lw)
	c := px(pitchW/2, pitchL/2)
	lines.ring(c[0], c[1], 9.15*bxScale, lw)
	spots.circle(c[0], c[1], .4*bxScale)
	for _, top := range []bool{true, false} {
		y := func(d float64) float64 {
			if top {
				return d
			}
			return pitchL - d
		}
		for _, a := range [][2]float64{{40.3, 16.5}, {18.3, 5.5}} {
			p := px((pitchW-a[0])/2, min(y(0), y(a[1])))
			lines.rect(p[0], p[1], a[0]*bxScale, a[1]*bxScale, lw)
		}
		s := px(pitchW/2, y(11))
		spots.circle(s[0], s[1], .4*bxScale)
		g := px((pitchW-7.3)/2, min(y(0), y(0)-1.6))
		if !top {
			g = px((pitchW-7.3)/2, pitchL)
		}
		lines.rect(g[0], g[1], 7.3*bxScale, 1.6*bxScale, lw)
	}
	lineCol := rgba(mix(bg, team, .55))
	lines.draw(img, lineCol)
	spots.draw(img, lineCol)

	pos, ball, arrows := b.State.frame(step)

	// Flechas: el trazo acaba donde empieza la punta.
	var arr shape
	aw := .45 * bxScale
	for _, a := range arrows {
		dx, dy := a.To.X-a.From.X, a.To.Y-a.From.Y
		l := math.Hypot(dx, dy)
		if l < .5 {
			continue
		}
		ux, uy := dx/l, dy/l
		head := min(1.8, l*.6)
		end := BoardPoint{a.To.X - ux*head, a.To.Y - uy*head}
		switch a.Kind {
		case "pass":
			arr.line(pp(a.From), pp(end), aw)
		case "dribble":
			var pts [][2]float64
			for _, p := range wavePoints(a.From, end) {
				pts = append(pts, pp(p))
			}
			arr.polyline(pts, aw)
		default: // carrera: discontinua
			for s := 0.0; s < l-head; s += 2.3 {
				e := min(s+1.4, l-head)
				arr.line(pp(BoardPoint{a.From.X + ux*s, a.From.Y + uy*s}), pp(BoardPoint{a.From.X + ux*e, a.From.Y + uy*e}), aw)
			}
		}
		nx, ny := -uy*.7, ux*.7
		arr.poly(pp(a.To), pp(BoardPoint{end.X - nx, end.Y - ny}), pp(BoardPoint{end.X + nx, end.Y + ny}))
	}
	arr.draw(img, rgba(fg))

	// Fichas: borde claro, círculo del equipo, dorsal o posición y nombre.
	var rims, discs shape
	for _, p := range pos {
		q := pp(p)
		rims.circle(q[0], q[1], 3.8*bxScale)
		discs.circle(q[0], q[1], 3.4*bxScale)
	}
	rims.draw(img, rgba(bg))
	discs.draw(img, rgba(team))
	for i, p := range pos {
		q := pp(p)
		label := b.State.Tokens[i].Label
		if label == "" {
			label = fmt.Sprint(i + 1)
		}
		if err := text(label, 2.3*bxScale, teamFg, q[0], q[1]+.8*bxScale, true); err != nil {
			return nil, err
		}
		if n := b.State.Tokens[i].Name; n != "" {
			if err := text(n, 2.3*bxScale, rgba(ink), q[0], q[1]+6.4*bxScale, true); err != nil {
				return nil, err
			}
		}
	}

	var ballRim, ballFill shape
	bq := pp(ball)
	ballRim.circle(bq[0], bq[1], 1.75*bxScale)
	ballFill.circle(bq[0], bq[1], 1.4*bxScale)
	ballRim.draw(img, rgba(fg))
	ballFill.draw(img, color.RGBA{255, 255, 255, 255})

	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
