package cmdb

import (
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	mathrand "math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	captchaLength = 4
	captchaTTL    = 5 * time.Minute
	captchaMax    = 1024
)

const captchaAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

var captchaGlyphs = map[byte][7]string{
	'A': {"01110", "10001", "10001", "11111", "10001", "10001", "10001"},
	'B': {"11110", "10001", "10001", "11110", "10001", "10001", "11110"},
	'C': {"01111", "10000", "10000", "10000", "10000", "10000", "01111"},
	'D': {"11110", "10001", "10001", "10001", "10001", "10001", "11110"},
	'E': {"11111", "10000", "10000", "11110", "10000", "10000", "11111"},
	'F': {"11111", "10000", "10000", "11110", "10000", "10000", "10000"},
	'G': {"01111", "10000", "10000", "10111", "10001", "10001", "01111"},
	'H': {"10001", "10001", "10001", "11111", "10001", "10001", "10001"},
	'J': {"00111", "00010", "00010", "00010", "00010", "10010", "01100"},
	'K': {"10001", "10010", "10100", "11000", "10100", "10010", "10001"},
	'L': {"10000", "10000", "10000", "10000", "10000", "10000", "11111"},
	'M': {"10001", "11011", "10101", "10101", "10001", "10001", "10001"},
	'N': {"10001", "11001", "10101", "10011", "10001", "10001", "10001"},
	'P': {"11110", "10001", "10001", "11110", "10000", "10000", "10000"},
	'Q': {"01110", "10001", "10001", "10001", "10101", "10010", "01101"},
	'R': {"11110", "10001", "10001", "11110", "10100", "10010", "10001"},
	'S': {"01111", "10000", "10000", "01110", "00001", "00001", "11110"},
	'T': {"11111", "00100", "00100", "00100", "00100", "00100", "00100"},
	'U': {"10001", "10001", "10001", "10001", "10001", "10001", "01110"},
	'V': {"10001", "10001", "10001", "10001", "10001", "01010", "00100"},
	'W': {"10001", "10001", "10001", "10101", "10101", "11011", "10001"},
	'X': {"10001", "10001", "01010", "00100", "01010", "10001", "10001"},
	'Y': {"10001", "10001", "01010", "00100", "00100", "00100", "00100"},
	'Z': {"11111", "00001", "00010", "00100", "01000", "10000", "11111"},
	'2': {"01110", "10001", "00001", "00010", "00100", "01000", "11111"},
	'3': {"11110", "00001", "00001", "01110", "00001", "00001", "11110"},
	'4': {"00010", "00110", "01010", "10010", "11111", "00010", "00010"},
	'5': {"11111", "10000", "10000", "11110", "00001", "00001", "11110"},
	'6': {"01110", "10000", "10000", "11110", "10001", "10001", "01110"},
	'7': {"11111", "00001", "00010", "00100", "01000", "01000", "01000"},
	'8': {"01110", "10001", "10001", "01110", "10001", "10001", "01110"},
	'9': {"01110", "10001", "10001", "01111", "00001", "00001", "01110"},
}

type captchaEntry struct {
	code    string
	expires time.Time
}

type captchaStore struct {
	mu      sync.Mutex
	entries map[string]captchaEntry
	max     int
}

func newCaptchaStore(max int) *captchaStore {
	if max < 1 {
		max = captchaMax
	}
	return &captchaStore{entries: make(map[string]captchaEntry), max: max}
}

func (s *captchaStore) issue(code string) string {
	id := randomToken(18)
	now := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()
	for key, entry := range s.entries {
		if now.After(entry.expires) {
			delete(s.entries, key)
		}
	}
	if len(s.entries) >= s.max {
		var oldestKey string
		var oldest time.Time
		for key, entry := range s.entries {
			if oldestKey == "" || entry.expires.Before(oldest) {
				oldestKey = key
				oldest = entry.expires
			}
		}
		delete(s.entries, oldestKey)
	}
	s.entries[id] = captchaEntry{code: strings.ToUpper(code), expires: now.Add(captchaTTL)}
	return id
}

func (s *captchaStore) verify(id, code string) bool {
	s.mu.Lock()
	entry, ok := s.entries[id]
	delete(s.entries, id)
	s.mu.Unlock()
	if !ok || time.Now().After(entry.expires) {
		return false
	}
	given := strings.ToUpper(strings.TrimSpace(code))
	return len(given) == len(entry.code) &&
		subtle.ConstantTimeCompare([]byte(given), []byte(entry.code)) == 1
}

func randomToken(size int) string {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand failure is effectively unrecoverable; use a timestamp fallback
		// so callers still get an unpredictable-enough identifier.
		return base64.RawURLEncoding.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return base64.RawURLEncoding.EncodeToString(raw)
}

func randomCaptchaCode() (string, error) {
	raw := make([]byte, captchaLength)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	for i := range raw {
		raw[i] = captchaAlphabet[int(raw[i])%len(captchaAlphabet)]
	}
	return string(raw), nil
}

func captchaPNG(code string, dark bool) ([]byte, error) {
	const width, height = 180, 58
	background := color.RGBA{R: 247, G: 250, B: 255, A: 255}
	noise := color.RGBA{R: 201, G: 215, B: 232, A: 255}
	palette := []color.RGBA{
		{R: 11, G: 74, B: 143, A: 255},
		{R: 15, G: 107, B: 92, A: 255},
		{R: 138, G: 75, B: 0, A: 255},
		{R: 107, G: 45, B: 138, A: 255},
	}
	if dark {
		background = color.RGBA{R: 31, G: 31, B: 31, A: 255}
		noise = color.RGBA{R: 67, G: 67, B: 67, A: 255}
		palette = []color.RGBA{
			{R: 105, G: 177, B: 255, A: 255},
			{R: 92, G: 219, B: 211, A: 255},
			{R: 255, G: 192, B: 105, A: 255},
			{R: 179, G: 127, B: 235, A: 255},
		}
	}

	img := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(img, img.Bounds(), &image.Uniform{C: background}, image.Point{}, draw.Src)
	for i := 0; i < 4; i++ {
		drawCaptchaLine(img,
			mathrand.IntN(width), mathrand.IntN(height),
			mathrand.IntN(width), mathrand.IntN(height), noise)
	}
	for i := 0; i < 55; i++ {
		img.Set(mathrand.IntN(width), mathrand.IntN(height), noise)
	}

	for i, ch := range []byte(code) {
		glyph, ok := captchaGlyphs[ch]
		if !ok {
			continue
		}
		x := 18 + i*38 + mathrand.IntN(7) - 3
		y := 10 + mathrand.IntN(7) - 3
		ink := palette[i%len(palette)]
		for row, line := range glyph {
			for column, pixel := range line {
				if pixel != '1' {
					continue
				}
				for dy := 0; dy < 4; dy++ {
					for dx := 0; dx < 4; dx++ {
						img.Set(x+column*4+dx, y+row*4+dy, ink)
					}
				}
			}
		}
	}

	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func drawCaptchaLine(img *image.RGBA, x0, y0, x1, y1 int, c color.RGBA) {
	dx := absInt(x1 - x0)
	dy := -absInt(y1 - y0)
	sx, sy := -1, -1
	if x0 < x1 {
		sx = 1
	}
	if y0 < y1 {
		sy = 1
	}
	err := dx + dy
	for {
		img.Set(x0, y0, c)
		if x0 == x1 && y0 == y1 {
			return
		}
		e2 := 2 * err
		if e2 >= dy {
			err += dy
			x0 += sx
		}
		if e2 <= dx {
			err += dx
			y0 += sy
		}
	}
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func (s *Server) issueCaptcha(w http.ResponseWriter, r *http.Request) {
	code, err := randomCaptchaCode()
	if err != nil {
		fail(w, http.StatusInternalServerError, "验证码生成失败")
		return
	}
	id := s.captchas.issue(code)
	data, err := captchaPNG(code, r.URL.Query().Get("theme") == "dark")
	if err != nil {
		fail(w, http.StatusInternalServerError, "验证码生成失败")
		return
	}
	respond(w, http.StatusOK, map[string]string{
		"id":    id,
		"image": "data:image/png;base64," + base64.StdEncoding.EncodeToString(data),
	})
}
