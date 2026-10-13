package handlers

import (
	"context"
	"encoding/json"
	"errors"

	kmatev1 "github.com/kmate-dev/kmate/gen/go/kmate/v1"
	"github.com/kmate-dev/kmate/internal/agent/cache"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/jsonmergepatch"
)

func editJSON(u *unstructured.Unstructured) ([]byte, error) {
	u = u.DeepCopy()
	unstructured.RemoveNestedField(u.Object, "status")
	for _, key := range []string{"managedFields", "uid", "creationTimestamp", "generation", "resourceVersion", "selfLink"} {
		unstructured.RemoveNestedField(u.Object, "metadata", key)
	}
	return json.Marshal(u.Object)
}

func (h *Handler) applyDataEdit(ctx context.Context, req *kmatev1.Request, a *kmatev1.ApplyRequest, desired *unstructured.Unstructured, gvr schema.GroupVersionResource) (*kmatev1.Response, error) {
	dyn, _ := h.Clients.ForIdentity(req.GetIdentity())
	resource := dyn.Resource(gvr).Namespace(desired.GetNamespace())
	current, err := resource.Get(ctx, desired.GetName(), metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	version := a.GetObject().GetResourceVersion()
	if current.GetResourceVersion() != version {
		return nil, apierrors.NewConflict(gvr.GroupResource(), desired.GetName(), errors.New("object changed since the editor loaded it; reload before saving"))
	}
	before, err := editJSON(current)
	if err != nil {
		return nil, err
	}
	after, err := editJSON(desired)
	if err != nil {
		return nil, err
	}
	patch, err := jsonmergepatch.CreateThreeWayJSONMergePatch(before, after, before)
	if err != nil {
		return nil, err
	}
	var body map[string]interface{}
	if err := json.Unmarshal(patch, &body); err != nil {
		return nil, err
	}
	metadata, _ := body["metadata"].(map[string]interface{})
	if metadata == nil {
		metadata = map[string]interface{}{}
		body["metadata"] = metadata
	}
	metadata["resourceVersion"] = version
	patch, err = json.Marshal(body)
	if err != nil {
		return nil, err
	}
	fm := a.GetFieldManager()
	if fm == "" {
		fm = "kmate"
	}
	opts := metav1.PatchOptions{FieldManager: fm}
	if a.GetDryRun() {
		opts.DryRun = []string{metav1.DryRunAll}
	}
	result, err := resource.Patch(ctx, desired.GetName(), types.MergePatchType, patch, opts)
	if err != nil {
		return nil, err
	}
	unstructured.RemoveNestedField(result.Object, "metadata", "managedFields")
	object, err := cache.ToKubeObject(result, false)
	if err != nil {
		return nil, err
	}
	return &kmatev1.Response{Kind: &kmatev1.Response_Apply{Apply: &kmatev1.ApplyResponse{Object: object}}}, nil
}
