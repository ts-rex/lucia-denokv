import type { Adapter, DatabaseSession, DatabaseUser } from "lucia"
export type Options = {
	/**
	 * Prefix added to all db calls with the adapter.
	 */
	authPrefix: Deno.KvKeyPart[]
	/**
	 * Per *object* prefixes
	 */
	prefixes: {
		user: Deno.KvKeyPart[]
		session: Deno.KvKeyPart[]
		session_user: Deno.KvKeyPart[]
		user_sessions: Deno.KvKeyPart[]
	}
	/*
		Experimental Options
	*/
	experimental: Partial<{
		/*
			Use deno expireIn to automatically purge sessions when they expire
		*/
		auto_expire: boolean
		logging: boolean
	}>
}

async function setSession(
	session: DatabaseSession,
	keys: Keys,
	opt: Options,
	db: Deno.Kv,
	allow_exists: boolean | Deno.KvEntry<DatabaseSession> = false,
) {
	if (!session.userId) {
		throw new MissingSessionUserID(
			"Missing User ID when setting session.",
		)
	}
	const user = (await db.get<DatabaseUser>(keys.user(session.userId))).value
	if (!user) {
		throw new SessionUserNotFound(
			"Invalid User ID when setting session.",
		)
	}
	const doExpireIn = opt.experimental.auto_expire
	const expireIn = doExpireIn
		? session.expiresAt.getTime() - new Date().getTime()
		: undefined
	const tx = db.atomic()
	if (allow_exists === false) {
		tx.check({ key: keys.session(session.id), versionstamp: null })
	} else if (typeof allow_exists != "boolean") {
		tx.check(allow_exists)
	}
	tx.set(keys.session(session.id), session, { expireIn })
	tx.set(
		keys.setSessionsByUser(session.userId, session.id),
		session.id,
		{ expireIn },
	)
	tx.set(keys.userBySession(session.id), session.userId, { expireIn })
	const res = await tx.commit()
	if (!res.ok) throw new SessionExists("Session already exists")
}

type Keys = ReturnType<typeof createKeys>

function createKeys(
	{
		authPrefix: auth,
		prefixes: {
			user,
			session,
			session_user,
			user_sessions,
		},
	}: Options,
) {
	function authPrefix(key: Deno.KvKey) {
		return [...auth, ...key]
	}
	return {
		user(user_id: string) {
			return authPrefix([...user, user_id])
		},
		session(session_id: string) {
			return authPrefix([...session, session_id])
		},
		userBySession(session_id: string) {
			return authPrefix([...session_user, session_id])
		},
		sessionsByUser(user_id: string) {
			return authPrefix([...user_sessions, user_id])
		},
		setSessionsByUser(user_id: string, session_id: string) {
			return authPrefix([...user_sessions, user_id, session_id])
		},
	}
}

type DeleteCallback = {
	(tx: Deno.AtomicOperation, userId: string): void | Promise<void>
}
type UserDelete = (userId: string, cb: DeleteCallback) => Promise<void>

type DenoKvAdapter = {
	deleteUser: UserDelete
	adapter: Adapter
	userKey(userId: string): Deno.KvKey
}

export default function kv(
	db: Deno.Kv,
	options?: Partial<Options>,
): DenoKvAdapter {
	if (!globalThis?.Deno) throw new Error("Are you running in Deno?")
	const opt: Options = Object.assign<Options, Partial<Options>>({
		authPrefix: ["auth"],
		prefixes: {
			user: ["user"],
			session: ["session"],
			session_user: ["session_user"],
			user_sessions: ["user_sessions"],
		},
		experimental: {
			auto_expire: false,
			logging: false,
		},
	}, options || {})
	const keys = createKeys(opt)
	const adapter: Adapter = {
		async deleteSession(sessionId) {
			if (opt.experimental.logging) {
				console.log("delete session:" + sessionId)
			}
			const userId =
				(await db.get<string>(keys.userBySession(sessionId))).value
			if (!userId) return
			const list =
				((await db.get<string[]>(keys.sessionsByUser(userId))).value ??
					[])
					.filter((list_id) => list_id !== sessionId)
			await db.atomic()
				.delete(keys.session(sessionId))
				.set(keys.sessionsByUser(userId), list)
				.delete(keys.userBySession(sessionId))
				.commit()
		},
		async deleteUserSessions(userId) {
			if (opt.experimental.logging) {
				console.log("delete user:sessions:" + userId)
			}
			const sessions = db.list<string>({
				prefix: keys.sessionsByUser(userId),
			})
			const tx = db.atomic()
			for await (const session of sessions) {
				const sessionId = session.value
				tx.delete(keys.userBySession(sessionId))
				tx.delete(keys.session(sessionId))
				tx.delete(session.key)
			}
			await tx.commit()
		},
		// Make sure to return session even if user could not be found, tells lucia to delete the stale session
		async getSessionAndUser(sessionId) {
			if (opt.experimental.logging) {
				console.log("get session:" + sessionId)
			}
			const session =
				(await db.get<DatabaseSession>(keys.session(sessionId))).value
			if (!session) return [null, null]
			const userId =
				(await db.get<string>(keys.userBySession(sessionId))).value
			if (!userId) return [session, null]
			const user = (await db.get<DatabaseUser>(
				keys.user(userId),
			)).value
			if (!user) return [session, null]
			return [session, user]
		},
		async getUserSessions(userId) {
			if (opt.experimental.logging) {
				console.log("get user:sessions:" + userId)
			}
			const list: DatabaseSession[] = []
			const sessions = db.list<string>({
				prefix: keys.sessionsByUser(userId),
			})
			for await (const session of sessions) {
				list.push(
					(await db.get<DatabaseSession>(keys.session(session.value)))
						?.value!,
				)
			}
			return list
		},
		async setSession(session) {
			if (opt.experimental.logging) {
				console.log("set session: ")
				console.log(session)
			}
			await setSession(session, keys, opt, db, false)
		},
		async updateSessionExpiration(sessionId, expiresAt) {
			if (opt.experimental.logging) {
				console.log(
					"set session:" + sessionId + ".expiration = " + expiresAt,
				)
			}
			const sessionReq = await db.get<DatabaseSession>(
				keys.session(sessionId),
			)
			const originalSession = sessionReq.value
			if (!originalSession) {
				throw new NonExistentSession(
					"Session not found (attempted updating session expiration)",
				)
			}
			const session = { ...sessionReq.value, expiresAt }
			await setSession(session, keys, opt, db, sessionReq)
		},

		async deleteExpiredSessions() {
			throw new Error("not implemented.")
		},
	}
	return {
		adapter,
		async deleteUser(userId, cb) {
			const deleteSessions =
				(await db.get<string[]>(keys.sessionsByUser(userId)))
					.value
			const tx = db.atomic()
				.delete(keys.sessionsByUser(userId))
			await cb(tx, userId)
			deleteSessions?.forEach((id) => {
				if (opt.experimental.logging) console.log("delete session:" + id)
				tx.delete(keys.session(id))
				tx.delete(keys.userBySession(id))
			})
			if (opt.experimental.logging) console.log("delete user:" + userId)
			await tx.commit()
		},
		userKey: (userId: string): Deno.KvKey => keys.user(userId),
	}
}

export class MissingSessionUserID extends Error {}
export class SessionUserNotFound extends Error {}
export class SessionExists extends Error {}
export class NonExistentSession extends Error {}

export { kv }
