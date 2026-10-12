import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cluster, errorMessage } from "@/services/api-client";

/** One "can I do X" question, mirroring authorization.k8s.io ResourceAttributes. */
export interface AccessQuestion {
  group?: string;
  version?: string;
  resource: string;
  subresource?: string;
  namespace?: string;
  name?: string;
  verb: string;
}

export interface AccessAnswer {
  allowed: boolean;
  denied: boolean;
  reason: string;
  /** True when the agent cannot impersonate, so the answer is about the agent, not you. */
  shared: boolean;
}

const accessKey = (q: AccessQuestion): string =>
  [q.group ?? "", q.version ?? "", q.resource, q.subresource ?? "", q.namespace ?? "", q.name ?? "", q.verb].join("|");

/**
 * Asks the cluster what the signed-in user may actually do.
 *
 * The agent answers with a SelfSubjectAccessReview while impersonating, which is
 * the same question `kubectl auth can-i` asks, so buttons reflect real Kubernetes
 * permissions rather than only what the agent was installed to allow.
 */
export const useAccessReview = (clusterId: string, questions: AccessQuestion[], enabled = true) => {
  const keys = questions.map(accessKey).join("\n");
  const q = useQuery({
    queryKey: ["accessReview", clusterId, keys],
    queryFn: async () => {
      const res = await cluster.accessReview({
        clusterId,
        review: {
          items: questions.map((x) => ({
            group: x.group ?? "", version: x.version ?? "", resource: x.resource,
            subresource: x.subresource ?? "", namespace: x.namespace ?? "", name: x.name ?? "", verb: x.verb,
          })),
        },
      });
      const out = new Map<string, AccessAnswer>();
      res.results.forEach((r, i) => {
        const question = questions[i];
        if (!question) return;
        out.set(accessKey(question), {
          allowed: r.allowed,
          denied: r.denied,
          reason: r.reason,
          shared: r.reason.startsWith("shared identity"),
        });
      });

      return out;
    },
    enabled: enabled && !!clusterId && questions.length > 0,
    staleTime: 30_000,
    retry: false,
  });

  const answers = q.data;

  return useMemo(
    () => ({
      /** Undefined while unknown, so callers can avoid disabling a button prematurely. */
      can(question: AccessQuestion): AccessAnswer | undefined {
        return answers?.get(accessKey(question));
      },
      loaded: !!answers,
      error: q.error ? errorMessage(q.error) : null,
    }),
    [answers, q.error],
  );
};

/* ---------------- users, grants and your own access ---------------- */
