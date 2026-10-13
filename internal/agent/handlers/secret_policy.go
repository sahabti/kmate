package handlers

import (
	"errors"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

func (h *Handler) checkSecrets(gvr schema.GroupVersionResource) error {
	if h.DenySecrets && gvr.Group == "" && gvr.Resource == "secrets" {
		return apierrors.NewForbidden(gvr.GroupResource(), "", errors.New("Secret access is disabled (rbac.secretsRead=false)"))
	}
	return nil
}
