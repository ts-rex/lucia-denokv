import type { Adapter } from "lucia";

export default function kv(database: Deno.Kv) {
  if(!window?.Deno) throw new Error("Are you running in Deno?")
}