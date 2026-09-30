{{- define "kmate-agent.name" -}}kmate-agent{{- end -}}
{{- define "kmate-agent.labels" -}}
app.kubernetes.io/name: kmate-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
