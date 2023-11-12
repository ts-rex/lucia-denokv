import type {
	Adapter,
	InitializeAdapter,
	KeySchema,
	SessionAdapter,
	SessionSchema,
	UserAdapter,
	UserSchema,
} from "lucia"
import {
	createDeleteOfUser,
	createDeleteXsByUserId,
	createGet,
	createGetByUserId,
	createSetOfUser,
	createUpdate,
} from "./factory.ts"

export type Options = {
	/**
	 * Runs whenever a user is deleted, incase there is any user data that should be cascaded on delete.
	 * @param tx
	 * @param user_id
	 */
	onDelete(tx: Deno.AtomicOperation, user_id: string): void
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
): InitializeAdapter<Adapter> {
	if (!window?.Deno) throw new Error("Are you running in Deno?")
	const opt: Options = Object.assign<Options, Partial<Options>>({
		authPrefix: ["auth"],
		onDelete: () => {},
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
	return (LuciaError) => {
		const session: SessionAdapter = {
			getSession: createGet<SessionSchema>(database, keys.session),
			getSessionsByUserId: createGetByUserId<SessionSchema>(
				database,
				keys.session,
				keys.keysByUser,
			),
			updateSession: createUpdate<SessionSchema>(
				database,
				keys.session,
				"session",
				LuciaError,
			),
			setSession: createSetOfUser<SessionSchema, UserSchema>(
				database,
				keys.user,
				keys.session,
				keys.sessionsByUser,
				keys.userBySession,
				LuciaError,
			),
			deleteSession: createDeleteOfUser(
				database,
				keys.session,
				keys.sessionsByUser,
				keys.userBySession,
			),
			deleteSessionsByUserId: createDeleteXsByUserId(
				database,
				keys.session,
				keys.sessionsByUser,
				keys.userBySession,
			),
		}

		const user: UserAdapter = {
			getUser: createGet<UserSchema>(database, keys.user),
			getKey: createGet<KeySchema>(database, keys.key),
			getKeysByUserId: createGetByUserId<KeySchema>(
				database,
				keys.key,
				keys.keysByUser,
			),
			updateKey: createUpdate<KeySchema>(
				database,
				keys.key,
				"key",
				LuciaError,
			),
			updateUser: createUpdate<UserSchema>(
				database,
				keys.user,
				"user",
				LuciaError,
			),
			setKey: createSetOfUser<KeySchema, UserSchema>(
				database,
				keys.user,
				keys.key,
				keys.keysByUser,
				keys.userByKey,
				LuciaError,
			),
			deleteKey: createDeleteOfUser(
				database,
				keys.key,
				keys.keysByUser,
				keys.userByKey,
			),
			deleteKeysByUserId: createDeleteXsByUserId(
				database,
				keys.key,
				keys.keysByUser,
				keys.userByKey,
			),
			async setUser(user, key) {
				if (key) {
					const exists = await database.get<KeySchema>(
						keys.key(key.id),
					)
					if (exists.value) {
						throw new LuciaError("AUTH_DUPLICATE_KEY_ID")
					}
				}
				const exists = await database.get<UserSchema>(
					keys.user(user.id),
				)
				if (exists.value) throw new LuciaError("AUTH_INVALID_USER_ID")
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
			async deleteUser(user_id) {
				const deleteKeys =
					(await database.get<string[]>(keys.keysByUser(user_id)))
						.value
				const deleteSessions =
					(await database.get<string[]>(keys.sessionsByUser(user_id)))
						.value
				const tx = await database.atomic()
					.delete(keys.user(user_id))
					.delete(keys.keysByUser(user_id))
					.delete(keys.sessionsByUser(user_id))
				await opt.onDelete(tx, user_id)
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
		}
		return { ...user, ...session }
	}
}
