type Schema = { id: string }
type SchemaWithUser = Schema & { user_id: string }

function createGet<T extends Schema>(db: Deno.Kv, key: window.keyFunc) {
    return async (id: string) => {
        return (await db.get<T>(key(id))).value
    }
}

function createUpdate<T extends Schema>(db: Deno.Kv, key: window.keyFunc) {
    return async (id: string, partial: Partial<T>) => {
        const value = (await db.get<T>(key(id))).value
        if (!value) throw new Error("Invalid ID")
        const newVal = { ...value, ...partial }
        await db.set(key(id), newVal)
    }
} 

function createGetByUserId<T extends Schema>(db: Deno.Kv, key: window.keyFunc, xByUser: window.keyFunc) {
    return async (user_id: string) => {
        const ids = (await db.get<string[]>(xByUser(user_id))).value;
        if(!ids) return []
        const keys = ids.map(id => key(id))
        const list = await db.getMany<T[]>(keys)
        return list.map(key => key.value).filter(key => key!==null) as T[]
    }
}

function createSetOfUser<T extends SchemaWithUser, User extends Schema>(db: Deno.Kv, userKey: window.keyFunc, key: window.keyFunc, xByUser: window.keyFunc, userByX: window.keyFunc) {
    return async (data: T) => {
        if(!data.user_id) throw new Error("Invalid user ID")
        const user = (await db.get<User>(userKey(data.user_id))).value
        if(!user) throw new Error("Invalid User ID")
        const exists = (await db.get<T>(key(data.id))).value
        if(exists) throw new Error("Duplicate Key")
        const oldValues = (await db.get<string[]>(xByUser(data.user_id))).value ?? []
        await db.atomic()
            .set(key(data.id), data)
            .set(xByUser(data.user_id), [ ...oldValues, data.id ])
            .set(userByX(data.id), data.user_id)
            .commit()
    }
}

function createDeleteOfUser(db: Deno.Kv, key: window.keyFunc, xByUser: window.keyFunc, userByX: window.keyFunc) {
    return async (id: string) => {
        const user_id = (await db.get<string>(userByX(id))).value;
        if(!user_id) return;
        const list = ((await db.get<string[]>(xByUser(user_id))).value ?? []).filter(list_id => list_id !== id)
        await db.atomic()
            .delete(key(id))
            .set(xByUser(user_id), list)
            .delete(userByX(id))
            .commit()
    }
}

function createDeleteXsByUserId(db: Deno.Kv, key: window.keyFunc, xByUser: window.keyFunc, userByX: window.keyFunc) {
    return async (user_id: string) => {
        const list = (await db.get<string[]>(xByUser(user_id))).value ?? []
        const tx = db.atomic()
            .set(xByUser(user_id), []);
        list.forEach((id) => {
            tx.delete(userByX(id))
            tx.delete(key(id))
        })
        await tx.commit()
    }
}

export {
    createGet,
    createUpdate,
    createGetByUserId,
    createSetOfUser,
    createDeleteOfUser,
    createDeleteXsByUserId
}