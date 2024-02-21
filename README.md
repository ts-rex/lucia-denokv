A lucia dapter for the [Deno KV](https://deno.com/kv) database.

Currently no docs but you can view mod.test.ts to see the basics

> [!CAUTION]
> .deleteExpiredSessions can be very memory and time instensive. 
> `options.experimental.auto_expire` is an alternative that tells denoKV to automatically delete your session, but it is not fully on the dot reliable.

```ts
const db = Deno.openKv(/*...*/); // or import { openKv } from "@deno/kv"
const luciaKv = luciaKvAdapter(db); // the return type of kv has some extra tools, do not discard
const auth = new Lucia(luciaKv.adapter);

export { db, luciaKv, auth };
```