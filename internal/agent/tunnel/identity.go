package tunnel

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Identity is what the agent stores after enrollment.
type Identity struct {
	AgentID    string `json:"agentId"`
	ClusterID  string `json:"clusterId"`
	AgentToken string `json:"agentToken,omitempty"`
	CertPEM    []byte `json:"certPem,omitempty"`
	KeyPEM     []byte `json:"keyPem,omitempty"`
	CAPEM      []byte `json:"caPem,omitempty"`
}

// IdentityStore persists the identity.
type IdentityStore interface {
	Load(ctx context.Context) (*Identity, error) // nil,nil when absent
	Save(ctx context.Context, id *Identity) error
}

// MemoryStore keeps identity in memory only.
type MemoryStore struct{ id *Identity }

func (m *MemoryStore) Load(context.Context) (*Identity, error) { return m.id, nil }
func (m *MemoryStore) Save(_ context.Context, id *Identity) error {
	m.id = id
	return nil
}

// SecretStore persists identity in a Kubernetes Secret.
type SecretStore struct {
	Client    kubernetes.Interface
	Namespace string
	Name      string
	Log       *slog.Logger
	fallback  MemoryStore
}

func (s *SecretStore) Load(ctx context.Context) (*Identity, error) {
	if s.fallback.id != nil {
		return s.fallback.id, nil
	}
	sec, err := s.Client.CoreV1().Secrets(s.Namespace).Get(ctx, s.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		s.Log.Warn("identity secret unreadable, using memory", "err", err)
		return nil, nil
	}
	raw, ok := sec.Data["identity.json"]
	if !ok {
		return nil, nil
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, fmt.Errorf("corrupt identity secret: %w", err)
	}
	return &id, nil
}

func (s *SecretStore) Save(ctx context.Context, id *Identity) error {
	s.fallback.id = id
	raw, err := json.Marshal(id)
	if err != nil {
		return err
	}
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: s.Name, Namespace: s.Namespace, Labels: map[string]string{"app.kubernetes.io/name": "kmate-agent"}},
		Type:       corev1.SecretTypeOpaque,
		Data:       map[string][]byte{"identity.json": raw},
	}
	existing, err := s.Client.CoreV1().Secrets(s.Namespace).Get(ctx, s.Name, metav1.GetOptions{})
	if err == nil {
		existing.Data = sec.Data
		_, err = s.Client.CoreV1().Secrets(s.Namespace).Update(ctx, existing, metav1.UpdateOptions{})
	} else if apierrors.IsNotFound(err) {
		_, err = s.Client.CoreV1().Secrets(s.Namespace).Create(ctx, sec, metav1.CreateOptions{})
	}
	if err != nil {
		s.Log.Warn("could not persist identity secret; keeping in memory", "err", err)
	}
	return nil
}

// Deleter is implemented by stores that can forget a rejected identity.
type Deleter interface {
	Delete(ctx context.Context) error
}

// FileStore persists identity as a 0600 JSON file (out-of-cluster runs).
type FileStore struct {
	Path string
	Log  *slog.Logger
}

func (f *FileStore) Load(context.Context) (*Identity, error) {
	raw, err := os.ReadFile(f.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var id Identity
	if err := json.Unmarshal(raw, &id); err != nil {
		return nil, fmt.Errorf("corrupt identity file %s: %w", f.Path, err)
	}
	if id.AgentID == "" {
		return nil, nil
	}
	return &id, nil
}

func (f *FileStore) Save(_ context.Context, id *Identity) error {
	raw, err := json.MarshalIndent(id, "", "  ")
	if err != nil {
		return err
	}
	tmp := f.Path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.Path)
}

func (f *FileStore) Delete(context.Context) error {
	if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (s *SecretStore) Delete(ctx context.Context) error {
	s.fallback.id = nil
	err := s.Client.CoreV1().Secrets(s.Namespace).Delete(ctx, s.Name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}
