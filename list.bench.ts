import { openKv } from "kv"
import { luciaKvAdapter } from "./mod.ts"
import { type DatabaseSession } from "lucia"

const db = await openKv()
const adapter = luciaKvAdapter(db, {
	experimental: {
		logging: true,
	},
})

const userId = "1"

Deno.bench("get user sessions with list and get", async () => {
	const list: DatabaseSession[] = []
	const sessions = db.list<string>({
		prefix: adapter.keys.sessionsByUser(userId),
	})
	for await (const session of sessions) {
		list.push(
			(await db.get<DatabaseSession>(adapter.keys.session(session.value)))
				?.value!,
		)
	}
})

Deno.bench("get user sessions with list and getMany", async () => {
	const sessions = await Array.fromAsync(db.list<string>({
		prefix: adapter.keys.sessionsByUser(userId),
	}))
	const list: DatabaseSession[] = []
	// loop through every 10 elements of the array
	for (let i = 0; i < sessions.length; i += 10) {
		// get the next 10 elements
		const next = sessions.slice(i, i + 10)
		// get the values of the next 10 elements
		const values = await db.getMany<DatabaseSession[]>(
			next.map((session) => adapter.keys.session(session.value)),
		)
		// push the values to the list
		list.push(...values.map((value) => value.value!))
	}
})
