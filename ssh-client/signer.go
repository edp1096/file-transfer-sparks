package main

import (
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"

	"golang.org/x/crypto/ssh"
)

func parsePemBlock(block *pem.Block) (interface{}, error) {
	switch block.Type {
	case "RSA PRIVATE KEY":
		privateKey, err := x509.ParsePKCS1PrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return privateKey, nil
	case "EC PRIVATE KEY":
		privateKey, err := x509.ParseECPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return privateKey, nil
	case "DSA PRIVATE KEY":
		privateKey, err := ssh.ParseDSAPrivateKey(block.Bytes)
		if err != nil {
			return nil, err
		}
		return privateKey, nil
	default:
		return nil, fmt.Errorf("unsupported key type %v", block.Type)
	}
}

func setSigner(fpath string) (ssh.Signer, error) {
	var err error
	var privateKey interface{}

	keyData, err := os.ReadFile(fpath)
	if err != nil {
		return nil, err
	}

	block, _ := pem.Decode(keyData)
	if block == nil {
		return nil, err
	}

	privateKey, err = parsePemBlock(block)
	if err != nil {
		return nil, err
	}

	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		return nil, err
	}

	return signer, nil
}
