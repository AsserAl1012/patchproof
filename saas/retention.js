export async function runRetention({ store, artifactStore, now = new Date(), dryRun = false } = {}) {
  if (!store?.retentionPlan) throw new Error("Store does not support retention planning.");
  const plan = await store.retentionPlan({ now });
  const deletedArtifacts = [];

  if (!dryRun && artifactStore?.delete) {
    for (const artifact of plan.expiredArtifacts || []) {
      await artifactStore.delete(artifact);
      deletedArtifacts.push(artifact.id);
    }
  }

  const applied = dryRun
    ? {
        sessions: 0,
        artifacts: 0,
        auditEvents: 0,
        githubDeliveries: 0
      }
    : await store.applyRetentionPlan(plan);

  return {
    dryRun,
    planned: {
      sessions: plan.expiredSessions?.length || 0,
      artifacts: plan.expiredArtifacts?.length || 0,
      auditEvents: plan.expiredAuditEvents?.length || 0,
      githubDeliveries: plan.expiredGitHubDeliveries?.length || 0
    },
    deletedArtifacts,
    applied
  };
}
