// Package creds generates randomized login/password for worker accounts.
package creds

import (
	"crypto/rand"
	"math/big"
	"strings"
)

// passwordAlphabet excludes visually ambiguous characters (0/O, 1/l/I).
const passwordAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const usernameAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

const (
	passwordLength = 16
	usernameLength = 10
)

// cyrToLat — simple Cyrillic-to-Latin transliteration (for a login built from the last name).
//
//nolint:gochecknoglobals // static lookup table
var cyrToLat = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e", 'ё': "e",
	'ж': "zh", 'з': "z", 'и': "i", 'й': "y", 'к': "k", 'л': "l", 'м': "m",
	'н': "n", 'о': "o", 'п': "p", 'р': "r", 'с': "s", 'т': "t", 'у': "u",
	'ф': "f", 'х': "kh", 'ц': "ts", 'ч': "ch", 'ш': "sh", 'щ': "shch",
	'ъ': "", 'ы': "y", 'ь': "", 'э': "e", 'ю': "yu", 'я': "ya",
}

// Transliterate returns the lowercase Latin transliteration of a string.
func Transliterate(s string) string {
	return transliterate(strings.ToLower(strings.TrimSpace(s)))
}

func transliterate(s string) string {
	var b strings.Builder
	for _, r := range s {
		if lat, ok := cyrToLat[r]; ok {
			b.WriteString(lat)
		}
	}
	return b.String()
}

// RandomPassword returns a random password without ambiguous characters.
func RandomPassword() (string, error) {
	return randomString(passwordAlphabet, passwordLength)
}

// RandomUsernameSuffix returns a random alphanumeric suffix to build a unique username.
func RandomUsernameSuffix() (string, error) {
	return randomString(usernameAlphabet, usernameLength)
}

func randomString(alphabet string, length int) (string, error) {
	out := make([]byte, length)
	maxIdx := big.NewInt(int64(len(alphabet)))
	for i := range out {
		n, err := rand.Int(rand.Reader, maxIdx)
		if err != nil {
			return "", err
		}
		out[i] = alphabet[n.Int64()]
	}
	return string(out), nil
}
