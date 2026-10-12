import { useQueryClient } from "@tanstack/react-query";

/** Invalidate every user/grant query after an administrative change. */
export const useRefreshUsers = () => {
  const qc = useQueryClient();

  return () => {
    void qc.invalidateQueries({ queryKey: ["users"] });
    void qc.invalidateQueries({ queryKey: ["grants"] });
  };
};
