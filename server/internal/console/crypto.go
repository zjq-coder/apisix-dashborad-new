package console

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

type Vault struct{ aead cipher.AEAD }

func NewVault(key string) (*Vault, error) {
	b, err := hex.DecodeString(key)
	if err != nil || len(b) != 32 {
		return nil, fmt.Errorf("DASHBOARD_ENCRYPTION_KEY must be 64 hex characters")
	}
	block, err := aes.NewCipher(b)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	return &Vault{aead: aead}, err
}
func (v *Vault) Seal(value any) (string, error) {
	plain, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, v.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return "", err
	}
	data := v.aead.Seal(nonce, nonce, plain, []byte("apisix-console:v1"))
	return base64.StdEncoding.EncodeToString(data), nil
}
func (v *Vault) Open(value string, out any) error {
	data, err := base64.StdEncoding.DecodeString(value)
	if err != nil {
		return err
	}
	n := v.aead.NonceSize()
	if len(data) < n {
		return fmt.Errorf("invalid encrypted record")
	}
	plain, err := v.aead.Open(nil, data[:n], data[n:], []byte("apisix-console:v1"))
	if err != nil {
		return err
	}
	return json.Unmarshal(plain, out)
}
