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
}

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
	function authPrefix(key: Deno.KvKeyPart[]) {
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
	}
}

type DeleteCallback = {
	(tx: Deno.AtomicOperation, userId: string): void | Promise<void>
}
type UserDelete = (userId: string, cb: DeleteCallback) => void

type DenoKvAdapter = { deleteUser: UserDelete; adapter: Adapter }

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
	}, options || {})
	const keys = createKeys(opt)
	const adapter: Adapter = {
		async deleteSession(sessionId) {
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
			const list =
				(await db.get<string[]>(keys.sessionsByUser(userId))).value ??
					[]
			const tx = db.atomic()
				.set(keys.sessionsByUser(userId), [])
			list.forEach((id) => {
				tx.delete(keys.userBySession(id))
				tx.delete(keys.session(id))
			})
			await tx.commit()
		},
		// Make sure to return session even if user could not be found, tells lucia to delete the stale session
		async getSessionAndUser(sessionId) {
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
			const sessionids =
				(await db.get<string[]>(keys.sessionsByUser(userId))).value
			if (!sessionids) return []
			const sessionkeys = sessionids.map((id) => keys.session(id))
			const list = await db.getMany<DatabaseSession[]>(sessionkeys)
			return list.map((key) => key.value).filter((key) =>
				key !== null
			) as DatabaseSession[]
		},
		async setSession(session) {
			if (!session.userId) {
				throw new MissingSessionUserID(
					"Missing User ID when setting session.",
				)
			}
			const user =
				(await db.get<DatabaseUser>(keys.user(session.userId))).value
			if (!user) {
				throw new SessionUserNotFound(
					"Invalid User ID when setting session.",
				)
			}
			const exists =
				(await db.get<DatabaseSession>(keys.session(session.id))).value
			if (exists) {
				throw new SessionExists(
					"Attempting to set session that already exists.",
				)
			}
			const oldValues =
				(await db.get<string[]>(keys.sessionsByUser(session.userId)))
					.value ?? []
			await db.atomic()
				.set(keys.session(session.id), session)
				.set(keys.sessionsByUser(session.userId), [
					...oldValues,
					session.id,
				])
				.set(keys.userBySession(session.id), session.userId)
				.commit()
		},
		async updateSessionExpiration(sessionId, expiresAt) {
			const sessionReq = await db.get<DatabaseSession>(
				keys.session(sessionId),
			)
			const session = sessionReq.value
			if (!session) {
				throw new NonExistentSession(
					"Session not found when updating session expiration",
				)
			}
			await db.atomic()
				.check(sessionReq)
				.set(sessionReq.key, {
					...session,
					expiresAt,
				})
				.commit()
		},
	}
	return {
		adapter,
		async deleteUser(userId, cb) {
			const deleteSessions =
				(await db.get<string[]>(keys.sessionsByUser(userId)))
					.value
			const tx = await db.atomic()
				.delete(keys.sessionsByUser(userId))
			await cb(tx, userId)
			deleteSessions?.forEach((id) => {
				tx.delete(keys.session(id))
			})
			await tx.commit()
		},
	}
}

export class MissingSessionUserID extends Error {}
export class SessionUserNotFound extends Error {}
export class SessionExists extends Error {}
export class NonExistentSession extends Error {}
