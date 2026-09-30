package cache

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/fields"
)

func TestFieldSelectorPaths(t *testing.T) {
	u := &unstructured.Unstructured{Object: map[string]interface{}{
		"metadata":       map[string]interface{}{"name": "p1", "namespace": "shop"},
		"spec":           map[string]interface{}{"nodeName": "node-a"},
		"status":         map[string]interface{}{"phase": "Running"},
		"involvedObject": map[string]interface{}{"name": "web", "kind": "Pod"},
	}}
	cases := map[string]bool{
		"spec.nodeName=node-a":                            true,
		"spec.nodeName=node-b":                            false,
		"status.phase!=Succeeded":                         true,
		"metadata.name=p1,spec.nodeName=node-a":           true,
		"involvedObject.name=web,involvedObject.kind=Pod": true,
		"spec.missing=x":                                  false,
		"spec.missing=":                                   true,
	}
	for expr, want := range cases {
		sel, err := fields.ParseSelector(expr)
		if err != nil {
			t.Fatal(err)
		}
		w := &watcher{fsel: sel}
		if got := w.matches(u); got != want {
			t.Errorf("%s: got %v want %v", expr, got, want)
		}
	}
}
