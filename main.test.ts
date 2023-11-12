import denoKV from './main.ts'


Deno.test("test create user", async () => {
    const db = await Deno.openKv();
    const adapter = denoKV(db);

    await adapter.setUser({ id: 'hello' }, null)
    db.close()
})

Deno.test("test create session & key", async () => {
    const db = await Deno.openKv();
    const adapter = denoKV(db);

    await adapter.setKey({
        hashed_password: 'sajisjd',
        id: "fkijeff",
        user_id: "hello"
    })
    console.log(await adapter.getUser('hello'))
    db.close()
})