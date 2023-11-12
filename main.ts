import type {
	Adapter,
	KeySchema,
	SessionAdapter,
	SessionSchema,
	UserAdapter,
	UserSchema,
} from "lucia"
import { LuciaError } from "lucia"

type Options = {
	doUser: boolean
	authPrefix: Deno.KvKeyPart[]
	prefixes: {
		user: Deno.KvKeyPart[]
		session: Deno.KvKeyPart[]
		key: Deno.KvKeyPart[]
		key_user: Deno.KvKeyPart[]
		user_sessions: Deno.KvKeyPart[]
		user_keys: Deno.KvKeyPart[]
		session_user: Deno.KvKeyPart[]
	}
}

function createKeys(
	{
		authPrefix: auth,
		prefixes: {
			user,
			session,
			key,
			key_user,
			user_sessions,
			user_keys,
			session_user,
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
		key(key_id: string) {
			return authPrefix([...key, key_id])
		},
		userByKey(key_id: string) {
			return authPrefix([...key_user, key_id])
		},
		keysByUser(user_id: string) {
			return authPrefix([...user_keys, user_id])
		},
	}
}

export default function kv(
	database: Deno.Kv,
	options?: Partial<Options>,
): Adapter {
	if (!window?.Deno) throw new Error("Are you running in Deno?")
	const opt: Options = Object.assign<Options, Partial<Options>>({
		doUser: true,
		authPrefix: ["auth"],
		prefixes: {
			user: ["user"],
			key: ["key"],
			key_user: ["key_user"],
			session: ["session"],
			session_user: ["session_user"],
			user_keys: ["user_keys"],
			user_sessions: ["user_sessions"],
		},
	}, options || {})
	const keys = createKeys(opt)

	const session: SessionAdapter = {
		async setSession(session) {
			if (!session.user_id) throw new LuciaError("AUTH_INVALID_USER_ID")
			const user =
				(await database.get<UserSchema>(keys.user(session.user_id)))
					.value
			if (!user) throw new LuciaError("AUTH_INVALID_USER_ID")
			const exists =
				(await database.get<SessionSchema>(keys.session(session.id)))
					.value
			if (exists) throw new LuciaError("AUTH_INVALID_SESSION_ID") // duplicate session error doesnt exist for whatever reason...

			const oldSessions = (await database.get<string[]>(
				keys.sessionsByUser(session.user_id),
			)).value ?? []
			await database.atomic()
				.set(keys.session(session.id), session)
				.set(keys.sessionsByUser(session.user_id), [
					...oldSessions,
					session.id,
				])
				.set(keys.userBySession(session.id), session.user_id)
				.commit()
		},
		async deleteSession(session_id) {
			const user_id =
				(await database.get<string>(keys.userBySession(session_id)))
					.value
			if (!user_id) return // either the session doesn't exist or smth went wrong
			const sessions =
				((await database.get<string[]>(keys.sessionsByUser(user_id)))
					.value ?? []).filter((list_session_id) =>
						list_session_id !== session_id
					)
			await database.atomic()
				.delete(keys.session(session_id))
				.set(keys.sessionsByUser(user_id), sessions)
				.delete(keys.userBySession(session_id))
				.commit()
		},
		async deleteSessionsByUserId(user_id) {
			const sessions =
				(await database.get<string[]>(keys.sessionsByUser(user_id)))
					.value ?? []
			const tx = database.atomic()
			sessions.forEach((session_id) => {
				tx.delete(keys.userBySession(session_id))
				tx.delete(keys.session(session_id))
			})
			tx.set(keys.sessionsByUser(user_id), [])
			await tx.commit()
		},
		async getSession(session_id) {
			return (await database.get<SessionSchema>(keys.session(session_id)))
				.value
		},
		async getSessionsByUserId(user_id) {
			const session_ids =
				(await database.get<string[]>(keys.sessionsByUser(user_id)))
					.value
			if (!session_ids) return []
			const session_keys = session_ids.map((session_id) =>
				keys.session(session_id)
			)
			const sessions = await database.getMany<SessionSchema[]>(
				session_keys,
			)
			return sessions.map((session) => session.value).filter((session) =>
				session !== null
			) as SessionSchema[]
		},
		async updateSession(session_id, partialSession) {
			const session =
				(await database.get<SessionSchema>(keys.session(session_id)))
					.value
			if (!session) throw new LuciaError("AUTH_INVALID_SESSION_ID")
			const newSession = { ...session, ...partialSession }
			await database.set(keys.session(session_id), newSession)
		},
	}

	const user: UserAdapter = {
		async setUser(user, key) {
			if (key) {
				const exists = await database.get<KeySchema>(keys.key(key.id))
				if (exists.value) throw new LuciaError("AUTH_DUPLICATE_KEY_ID")
			}
			const tx = database.atomic()
			tx.set(keys.user(user.id), user)
			if (key) {
				const uKeys =
					(await database.get<string[]>(keys.keysByUser(user.id)))
						.value ?? []
				const newUKeys = [uKeys, key.id]
				tx.set(keys.key(key.id), key)
				tx.set(keys.keysByUser(user.id), newUKeys)
				tx.set(keys.userByKey(key.user_id), key.id)
			}
			const ok = (await tx.commit()).ok
			if (!ok) {
				throw new LuciaError("UNKNOWN_ERROR")
			}
		},
		async getUser(user_id) {
			return (await database.get<UserSchema>(keys.user(user_id))).value
		},
		async getKey(key_id) {
			return (await database.get<KeySchema>(keys.key(key_id))).value
		},
		async getKeysByUserId(user_id) {
			const key_ids =
				(await database.get<string[]>(keys.keysByUser(user_id))).value
			if (!key_ids) return []
			const key_keys = key_ids.map((key_id) => keys.session(key_id))
			const keylist = await database.getMany<KeySchema[]>(key_keys)
			return keylist.map((key) => key.value).filter((key) =>
				key !== null
			) as KeySchema[]
		},
		async deleteKey(key_id) {
			const user_id = (await database.get<string>(keys.userByKey(key_id)))
				.value
			if (!user_id) return // either the key doesn't exist or smth went wrong
			const _keys =
				((await database.get<string[]>(keys.keysByUser(user_id)))
					.value ?? []).filter((list_key_id) =>
						list_key_id !== key_id
					)
			await database.atomic()
				.delete(keys.key(key_id))
				.set(keys.keysByUser(user_id), _keys)
				.delete(keys.user(key_id))
				.commit()
		},
		async deleteKeysByUserId(user_id) {
			const sessions =
				(await database.get<string[]>(keys.keysByUser(user_id)))
					.value ?? []
			const tx = database.atomic()
			sessions.forEach((session_id) => {
				tx.delete(keys.userByKey(session_id))
				tx.delete(keys.key(session_id))
			})
			tx.set(keys.keysByUser(user_id), [])
			await tx.commit()
		},
		async deleteUser(user_id) {
			const deleteKeys =
				(await database.get<string[]>(keys.keysByUser(user_id))).value
			const deleteSessions =
				(await database.get<string[]>(keys.sessionsByUser(user_id)))
					.value
			const tx = await database.atomic()
				.delete(keys.user(user_id))
				.delete(keys.keysByUser(user_id))
				.delete(keys.sessionsByUser(user_id))
			deleteKeys?.forEach((id) => {
				tx.delete(keys.key(id))
				tx.delete(keys.userByKey(id))
			})
			deleteSessions?.forEach((id) => {
				tx.delete(keys.session(id))
				tx.delete(keys.userByKey(id))
			})
			await tx.commit()
		},
		async setKey(key) {
			if (!key.user_id) throw new LuciaError("AUTH_INVALID_USER_ID")
			const user =
				(await database.get<UserSchema>(keys.user(key.user_id)))
					.value
			if (!user) throw new LuciaError("AUTH_INVALID_USER_ID")
			const exists = (await database.get<SessionSchema>(keys.key(key.id)))
				.value
			if (exists) throw new LuciaError("AUTH_INVALID_SESSION_ID") // duplicate session error doesnt exist for whatever reason...

			const oldSessions = (await database.get<string[]>(
				keys.keysByUser(key.user_id),
			)).value ?? []
			await database.atomic()
				.set(keys.key(key.id), key)
				.set(keys.keysByUser(key.user_id), [
					...oldSessions,
					key.id,
				])
				.set(keys.userByKey(key.id), key.user_id)
				.commit()
		},
		async updateKey(key_id, partial_key) {
			const key = (await database.get<KeySchema>(keys.key(key_id)))
				.value
			if (!key) throw new LuciaError("AUTH_INVALID_KEY_ID")
			const newKey = { ...key, ...partial_key }
			await database.set(keys.key(key_id), newKey)
		},
		async updateUser(user_id, partial_user) {
			const user =
				(await database.get<UserSchema>(keys.user(user_id))).value
			if (!user) throw new LuciaError("AUTH_INVALID_USER_ID")
			const newUser = { ...user, ...partial_user }
			await database.set(keys.user(user_id), newUser)
		},
	}
	return { ...user, ...session }
}
