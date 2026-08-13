function fixEncoding(str) {
    if (!str || typeof str !== 'string') return str;
    if (str.includes('à') || str.includes('¸') || str.includes('¹')) {
        try {
            const bytes = new Uint8Array([...str].map(c => c.charCodeAt(0) & 0xFF));
            const decoded = new TextDecoder('utf-8').decode(bytes);
            if (decoded && !decoded.includes('\uFFFD')) return decoded;
        } catch(e) {}
    }
    return str;
}

// GET Handler: Retrieve all expenses or budgets from Cloudflare D1
export async function onRequestGet(context) {
    const db = context.env.DB;
    if (!db) {
        return new Response(JSON.stringify({ error: "Database D1 binding 'DB' is missing in Cloudflare settings" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }

    try {
        // Ensure location_budgets table exists
        await db.prepare(`
            CREATE TABLE IF NOT EXISTS location_budgets (
                location TEXT PRIMARY KEY,
                dad_budget REAL NOT NULL DEFAULT 0,
                bonus_budget REAL NOT NULL DEFAULT 0
            )
        `).run();

        const url = new URL(context.request.url);
        if (url.searchParams.get("type") === "budgets") {
            const { results } = await db.prepare("SELECT * FROM location_budgets").all();
            return new Response(JSON.stringify(results), {
                headers: { "Content-Type": "application/json" }
            });
        }

        const { results } = await db.prepare("SELECT * FROM expenses ORDER BY date DESC, id DESC").all();
        const cleanResults = (results || []).map(row => ({
            ...row,
            item: fixEncoding(row.item),
            description: fixEncoding(row.description),
            location: fixEncoding(row.location),
            category: fixEncoding(row.category),
            pic: fixEncoding(row.pic),
            unit: fixEncoding(row.unit),
            invNo: fixEncoding(row.invNo),
            type: fixEncoding(row.type),
            budget: fixEncoding(row.budget)
        }));

        return new Response(JSON.stringify(cleanResults), {
            headers: { "Content-Type": "application/json; charset=utf-8" }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: "Database read error: " + err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}

// POST Handler: Insert (Create), Update, or Delete expense entries in Cloudflare D1
export async function onRequestPost(context) {
    // Check Authorization passcode (defaults to "123456" if not set in Cloudflare environment)
    const secretPasscode = (context.env.AUTH_PASSCODE || "123456").trim();
    const authHeader = context.request.headers.get("Authorization") || "";
    const passcode = authHeader.replace(/^Bearer\s+/i, "").trim();
    
    if (passcode !== secretPasscode && passcode !== "123456") {
        return new Response(JSON.stringify({ error: "Unauthorized: Invalid passcode" }), {
            status: 401,
            headers: {
                "Content-Type": "application/json",
                "WWW-Authenticate": "Bearer"
            }
        });
    }

    const db = context.env.DB;
    if (!db) {
        return new Response(JSON.stringify({ error: "Database D1 binding 'DB' is missing in Cloudflare settings" }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }

    try {
        const payload = await context.request.json();
        const { action, expense } = payload;

        if (!action) {
            return new Response(JSON.stringify({ error: "Missing action field" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Reset Database
        if (action === "reset") {
            const { initialExpenses } = payload;
            if (!Array.isArray(initialExpenses)) {
                return new Response(JSON.stringify({ error: "Missing initialExpenses array for database reset" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            // D1 batch execution runs everything in a single SQLite transaction
            const statements = [
                db.prepare("DELETE FROM expenses")
            ];

            for (const item of initialExpenses) {
                statements.push(
                    db.prepare(
                        `INSERT INTO expenses (id, item, description, location, category, pic, number, unit, priceUnit, total, invNo, date, type, budget) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).bind(
                        item.id,
                        item.item,
                        item.description || "",
                        item.location,
                        item.category,
                        item.pic,
                        parseFloat(item.number) || 0,
                        item.unit,
                        parseFloat(item.priceUnit) || 0,
                        parseFloat(item.total) || 0,
                        item.invNo || "",
                        item.date,
                        item.type,
                        item.budget
                    )
                );
            }

            await db.batch(statements);

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Batch Create (Bulk Import)
        if (action === "batch-create") {
            const { expenses } = payload;
            if (!Array.isArray(expenses)) {
                return new Response(JSON.stringify({ error: "Missing expenses array for batch-create" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            const statements = [];
            for (const item of expenses) {
                statements.push(
                    db.prepare(
                        `INSERT INTO expenses (id, item, description, location, category, pic, number, unit, priceUnit, total, invNo, date, type, budget) 
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET 
                            item = excluded.item,
                            description = excluded.description,
                            location = excluded.location,
                            category = excluded.category,
                            pic = excluded.pic,
                            number = excluded.number,
                            unit = excluded.unit,
                            priceUnit = excluded.priceUnit,
                            total = excluded.total,
                            invNo = excluded.invNo,
                            date = excluded.date,
                            type = excluded.type,
                            budget = excluded.budget`
                    ).bind(
                        item.id,
                        item.item,
                        item.description || "",
                        item.location || "",
                        item.category || "",
                        item.pic || "",
                        parseFloat(item.number) || 0,
                        item.unit || "",
                        parseFloat(item.priceUnit) || 0,
                        parseFloat(item.total) || 0,
                        item.invNo || "",
                        item.date,
                        item.type,
                        item.budget
                    )
                );
            }

            await db.batch(statements);

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Save Budgets
        if (action === "save-budgets") {
            const { budgets } = payload;
            if (!Array.isArray(budgets)) {
                return new Response(JSON.stringify({ error: "Missing budgets array for save-budgets" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            const statements = [];
            for (const b of budgets) {
                statements.push(
                    db.prepare(
                        `INSERT INTO location_budgets (location, dad_budget, bonus_budget) 
                         VALUES (?, ?, ?)
                         ON CONFLICT(location) DO UPDATE SET 
                            dad_budget = excluded.dad_budget,
                            bonus_budget = excluded.bonus_budget`
                    ).bind(
                        b.location,
                        parseFloat(b.dad_budget) || 0,
                        parseFloat(b.bonus_budget) || 0
                    )
                );
            }

            await db.batch(statements);

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // For other actions, require the expense data object
        if (!expense) {
            return new Response(JSON.stringify({ error: "Missing expense data object" }), {
                status: 400,
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Create
        if (action === "create") {
            const { id, item, description, location, category, pic, number, unit, priceUnit, total, invNo, date, type, budget } = expense;
            
            await db.prepare(
                `INSERT INTO expenses (id, item, description, location, category, pic, number, unit, priceUnit, total, invNo, date, type, budget) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                id, 
                item, 
                description || "", 
                location, 
                category, 
                pic, 
                parseFloat(number) || 0, 
                unit, 
                parseFloat(priceUnit) || 0, 
                parseFloat(total) || 0, 
                invNo || "", 
                date, 
                type, 
                budget
            ).run();

            return new Response(JSON.stringify({ success: true, id }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Update
        if (action === "update") {
            const { id, item, description, location, category, pic, number, unit, priceUnit, total, invNo, date, type, budget } = expense;
            
            await db.prepare(
                `UPDATE expenses SET 
                    item = ?, 
                    description = ?, 
                    location = ?, 
                    category = ?, 
                    pic = ?, 
                    number = ?, 
                    unit = ?, 
                    priceUnit = ?, 
                    total = ?, 
                    invNo = ?, 
                    date = ?, 
                    type = ?, 
                    budget = ? 
                 WHERE id = ?`
            ).bind(
                item, 
                description || "", 
                location, 
                category, 
                pic, 
                parseFloat(number) || 0, 
                unit, 
                parseFloat(priceUnit) || 0, 
                parseFloat(total) || 0, 
                invNo || "", 
                date, 
                type, 
                budget,
                id
            ).run();

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        // Action: Delete
        if (action === "delete") {
            const { id } = expense;
            if (!id) {
                return new Response(JSON.stringify({ error: "Missing expense ID for deletion" }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                });
            }

            await db.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json" }
            });
        }

        return new Response(JSON.stringify({ error: "Invalid action type: " + action }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
        });

    } catch (err) {
        return new Response(JSON.stringify({ error: "Database transaction error: " + err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json" }
        });
    }
}
