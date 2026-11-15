import { ledgerCsv } from "@/lib/mesh/export";
import { sessionFor, withWorkspace } from "@/lib/mesh/store";

export async function GET(request: Request) {
  const session = sessionFor(request);
  if (session.fresh) return Response.json({ error: "Open your workspace before exporting." }, { status: 401 });
  const format = new URL(request.url).searchParams.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") return Response.json({ error: "Choose csv or json." }, { status: 400 });
  try {
    return await withWorkspace(session.id, (state) => ({ state, result: new Response(format === "csv" ? ledgerCsv(state) : JSON.stringify(state, null, 2), {
      headers: { "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json", "Content-Disposition": `attachment; filename="ledgermesh-ledger.${format}"`, "Cache-Control": "no-store" },
    }) }));
  } catch { return Response.json({ error: "Could not export workspace." }, { status: 500 }); }
}
