package handlers

import (
	"context"
	"errors"
	"fmt"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/cache"
	authzv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The informer belongs to the agent, so an access review must precede every
// cached response. UI capability checks are never an authorization boundary.
func (h *Handler) authorizeCachedRead(ctx context.Context, req *kmatev1.Request, g *kmatev1.GVR, ns, name, verb string) error {
	gvr := cache.GVR(g)
	if !h.Clients.CanImpersonate {
		return nil
	}
	if req.GetIdentity().GetUser() == "" {
		return apierrors.NewForbidden(gvr.GroupResource(), name, errors.New("a user identity is required"))
	}
	_, cs := h.Clients.ForIdentity(req.GetIdentity())
	result, err := cs.AuthorizationV1().SelfSubjectAccessReviews().Create(ctx, &authzv1.SelfSubjectAccessReview{
		Spec: authzv1.SelfSubjectAccessReviewSpec{ResourceAttributes: &authzv1.ResourceAttributes{
			Group: gvr.Group, Version: gvr.Version, Resource: gvr.Resource, Namespace: ns, Name: name, Verb: verb,
		}},
	}, metav1.CreateOptions{})
	if err != nil {
		return fmt.Errorf("authorize cached %s: %w", verb, err)
	}
	if !result.Status.Allowed {
		return apierrors.NewForbidden(gvr.GroupResource(), name, fmt.Errorf("user %q cannot %s: %s", req.GetIdentity().GetUser(), verb, result.Status.Reason))
	}
	return nil
}
