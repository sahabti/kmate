package handlers

import (
	"context"
	"strings"
	"sync"
	"time"

	authzv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
)

// accessReviewTTL is how long an answer stays cached per identity+question.
const accessReviewTTL = 30 * time.Second

type arEntry struct {
	res *kmatev1.AccessReviewResult
	at  time.Time
}

type arCache struct {
	mu sync.Mutex
	m  map[string]arEntry
}

var reviewCache = &arCache{m: map[string]arEntry{}}

func (c *arCache) get(key string) (*kmatev1.AccessReviewResult, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || time.Since(e.at) > accessReviewTTL {
		return nil, false
	}
	return e.res, true
}

func (c *arCache) put(key string, res *kmatev1.AccessReviewResult) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.m) > 8192 {
		c.m = map[string]arEntry{}
	}
	c.m[key] = arEntry{res: res, at: time.Now()}
}

func arKey(id *kmatev1.Identity, a *kmatev1.ResourceAttributes) string {
	return strings.Join([]string{
		id.GetUser(), strings.Join(id.GetGroups(), ","),
		a.GetGroup(), a.GetVersion(), a.GetResource(), a.GetSubresource(),
		a.GetNamespace(), a.GetName(), a.GetVerb(),
	}, "|")
}

// accessReview answers "can this identity do X" for a batch of questions.
//
// With impersonation the agent issues a SelfSubjectAccessReview using the
// impersonated client, which is exactly what `kubectl auth can-i` does: the API
// server evaluates its own RBAC for that user. Without impersonation the agent
// can only answer for itself, so the results describe the agent's ServiceAccount
// and say so in the reason.
func (h *Handler) accessReview(ctx context.Context, req *kmatev1.Request, ar *kmatev1.AccessReviewRequest) (*kmatev1.Response, error) {
	id := req.GetIdentity()
	shared := !h.Clients.CanImpersonate
	_, cs := h.Clients.ForIdentity(id)

	results := make([]*kmatev1.AccessReviewResult, 0, len(ar.GetItems()))
	for _, item := range ar.GetItems() {
		key := arKey(id, item)
		if cached, ok := reviewCache.get(key); ok {
			results = append(results, cached)
			continue
		}
		verb := item.GetVerb()
		if verb == "" {
			verb = "get"
		}
		ssar := &authzv1.SelfSubjectAccessReview{
			Spec: authzv1.SelfSubjectAccessReviewSpec{
				ResourceAttributes: &authzv1.ResourceAttributes{
					Group:       item.GetGroup(),
					Version:     item.GetVersion(),
					Resource:    item.GetResource(),
					Subresource: item.GetSubresource(),
					Namespace:   item.GetNamespace(),
					Name:        item.GetName(),
					Verb:        verb,
				},
			},
		}
		out, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, ssar, metav1.CreateOptions{})
		var res *kmatev1.AccessReviewResult
		if err != nil {
			res = &kmatev1.AccessReviewResult{Reason: "access review failed: " + err.Error()}
		} else {
			res = &kmatev1.AccessReviewResult{
				Allowed: out.Status.Allowed,
				Denied:  out.Status.Denied,
				Reason:  out.Status.Reason,
			}
			if shared {
				res.Reason = strings.TrimSpace("shared identity (agent cannot impersonate): " + out.Status.Reason)
			}
			reviewCache.put(key, res)
		}
		results = append(results, res)
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_AccessReview{
		AccessReview: &kmatev1.AccessReviewResponse{Results: results},
	}}, nil
}
