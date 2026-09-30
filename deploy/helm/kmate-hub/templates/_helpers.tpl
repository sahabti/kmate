{{- define "kmate-hub.name" -}}{{ .Release.Name }}{{- end -}}
{{- define "kmate-hub.labels" -}}
app.kubernetes.io/name: kmate-hub
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
{{- define "kmate-hub.selectorLabels" -}}
app.kubernetes.io/name: kmate-hub
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "kmate-hub.secretName" -}}
{{- if .Values.admin.existingSecret }}{{ .Values.admin.existingSecret }}{{ else }}{{ include "kmate-hub.name" . }}-auth{{ end -}}
{{- end -}}
{{- define "kmate-hub.agentAddr" -}}
{{- if .Values.agentPublicAddr }}{{ .Values.agentPublicAddr }}{{ else }}{{ include "kmate-hub.name" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.service.agentPort }}{{ end -}}
{{- end -}}
