// Stand-in for Cloudflare's GraphQL Analytics API; never contacts the network.
export const ANALYTICS = { token: 'analytics-test-token', account: 'bca0917f4ae3bc29439e2e5007abd5a9', bucket: 'archive-under-test' };

/** Answers each dataset with fixed month-to-date values and records what was asked. */
export function analyticsService({ fail = [], redirect = [] } = {}) {
  const calls = [], elsewhere = [];
  const handler = async request => {
    if (request.url !== 'https://api.cloudflare.com/client/v4/graphql') { elsewhere.push(request.url); return new Response(null, { status: 503 }); }
    const { query, variables } = await request.json();
    const dataset = /(r2StorageAdaptiveGroups|r2OperationsAdaptiveGroups|durableObjectsPeriodicGroups|durableObjectsInvocationsAdaptiveGroups)/.exec(query)[1];
    calls.push({ dataset, variables, authorization: request.headers.get('authorization') });
    if (redirect.includes(dataset)) return new Response(null, { status: 302, headers: { location: 'https://collector.example/steal' } });
    if (fail.includes(dataset)) return Response.json({ data: null, errors: [{ message: `unknown field in ${dataset} for Bearer ${ANALYTICS.token}` }] });
    const rows = {
      r2StorageAdaptiveGroups: [{ max: { objectCount: 4200, payloadSize: 11_999_000_000, metadataSize: 1_000_000 }, dimensions: { datetime: variables.end } }],
      r2OperationsAdaptiveGroups: [['PutObject', 1_500_000], ['GetObject', 2_000_000], ['DeleteObject', 100], ['SomethingNew', 7]]
        .map(([actionType, requests]) => ({ sum: { requests }, dimensions: { actionType } })),
      // One row on the first of the month and one today (the same row on the 1st).
      durableObjectsPeriodicGroups: [...new Set([variables.start, variables.end])].map((date, i, all) => ({
        sum: all.length === 1 ? { rowsRead: 3e6, rowsWritten: 60e6, activeTime: 4e12 } : i ? { rowsRead: 2e6, rowsWritten: 30e6, activeTime: 3e12 } : { rowsRead: 1e6, rowsWritten: 30e6, activeTime: 1e12 },
        dimensions: { date, namespaceId: 'namespace-under-test' } })),
      durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 1_500_000 }, dimensions: { date: variables.end } }],
    }[dataset];
    return Response.json({ data: { viewer: { accounts: [{ [dataset]: rows }] } }, errors: null });
  };
  return { calls, elsewhere, handler };
}
