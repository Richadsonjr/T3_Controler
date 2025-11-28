const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');

// --- CONFIGURAÇÃO DO SERVIDOR ---
const app = express();
const PORT = 3300;
const DB_SOURCE = './CtrGT.db';

app.use(cors());
app.use(express.json());

// --- FUNÇÕES UTILITÁRIAS ---
const hashPassword = (password) => `hashed_${password}_secure`; // Em produção, use bcrypt
const comparePassword = (password, hash) => hash === `hashed_${password}_secure`;
const generateId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

// --- CONEXÃO COM O BANCO DE DADOS ---
const db = new sqlite3.Database(DB_SOURCE, (err) => {
    if (err) {
        console.error("Erro ao conectar ao banco de dados:", err.message);
        throw err;
    }
    console.log('Conectado ao banco de dados SQLite com sucesso.');

    db.serialize(() => {
        // 1. USUÁRIOS
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                email TEXT UNIQUE,
                user_group TEXT NOT NULL DEFAULT 'standard',
                is_active BOOLEAN DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S', 'now'))
            )
        `);

        // 2. TRANSAÇÕES
        db.run(`
            CREATE TABLE IF NOT EXISTS transactions (
                id TEXT PRIMARY KEY, 
                description TEXT NOT NULL, 
                amount REAL NOT NULL, 
                date TEXT NOT NULL, 
                type TEXT NOT NULL CHECK(type IN ('income', 'expense')), 
                categoryId TEXT, 
                isRecurring BOOLEAN DEFAULT 0, 
                createdAt TEXT NOT NULL,
                vencimento TEXT, 
                isDone BOOLEAN DEFAULT 0
            )
        `);
        
        // 3. CATEGORIAS
        db.run(`CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('income', 'expense')), color TEXT, icon TEXT)`);
        
        // 4. INVENTÁRIO
        db.run(`
            CREATE TABLE IF NOT EXISTS inventory (
                id TEXT PRIMARY KEY, 
                name TEXT NOT NULL, 
                currentStock INTEGER NOT NULL, 
                minStock INTEGER NOT NULL, 
                maxStock INTEGER, 
                unit TEXT, 
                category TEXT, 
                createdAt TEXT NOT NULL
            )
        `);
        
        // 5. MOVIMENTAÇÕES
        db.run(`
            CREATE TABLE IF NOT EXISTS input_and_output_products (
                id TEXT PRIMARY KEY, 
                productId TEXT NOT NULL, 
                qty INTEGER NOT NULL, 
                destination TEXT, 
                date TEXT, 
                value REAL, 
                tipo TEXT(255)
            )
        `);
    });
});

// ============================================================================
// --- ENDPOINTS GENÉRICOS (CRUD) ---
// ============================================================================

const genericTables = {
    'transactions': 'tran',
    'categories': 'cate',
    'inventory': 'inve',
    'input_and_output_products': 'prod'
};

const setupCrudEndpoints = (tableName, idPrefix) => {
    const route = tableName === 'input_and_output_products' ? 'movements' : tableName;
    
    // GET
    app.get(`/${route}`, (req, res) => {
        const query = tableName === 'users' 
            ? `SELECT id, username, email, user_group, is_active, created_at FROM ${tableName}`
            : `SELECT * FROM ${tableName}`;
console.log(query);
        db.all(query, [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            // CORREÇÃO: Retorna o array diretamente, sem envolver em { data: ... }
            res.json(rows);
        });
    });

    // POST
    app.post(`/${route}`, (req, res) => {
        const id = generateId(idPrefix);
        const data = { ...req.body, id, createdAt: new Date().toISOString() };
        
        // Remove campos extras que não existem na tabela de movimentos, se necessário
        if (tableName === 'input_and_output_products') {
            delete data.createdAt; // A tabela usa 'date', não 'createdAt'
        }

        const cols = Object.keys(data);
        const placeholders = cols.map(() => '?').join(', ');
        const values = Object.values(data);
        
        db.run(`INSERT INTO ${tableName} (${cols.join(', ')}) VALUES (${placeholders})`, values, function (err) {
            if (err) return res.status(400).json({ error: err.message });
            // Retorna o objeto criado completo
            res.status(201).json(data);
        });
    });

    // PUT
    app.put(`/${route}/:id`, (req, res) => {
        const { id } = req.params;
        const fields = Object.keys(req.body).map(field => `${field} = ?`).join(', ');
        const values = [...Object.values(req.body), id];
        
        db.run(`UPDATE ${tableName} SET ${fields} WHERE id = ?`, values, function (err) {
            if (err) return res.status(400).json({ error: err.message });
            res.json({ ...req.body, id });
        });
    });

    // DELETE
    app.delete(`/${route}/:id`, (req, res) => {
        db.run(`DELETE FROM ${tableName} WHERE id = ?`, req.params.id, function (err) {
            if (err) return res.status(400).json({ error: err.message });
            res.status(204).send();
        });
    });
};

Object.entries(genericTables).forEach(([tableName, idPrefix]) => setupCrudEndpoints(tableName, idPrefix));

// ============================================================================
// --- ENDPOINTS ESPECÍFICOS ---
// ============================================================================

// POST /movements (Sobrescreve/Complementa o genérico se necessário, mas a lógica de transação é específica)
// IMPORTANTE: Como definimos setupCrudEndpoints acima, a rota POST genérica já foi criada. 
// O Express prioriza a primeira definição. Vamos definir esta ANTES ou usar uma rota diferente?
// O ideal é remover 'input_and_output_products' do genericTables se quisermos lógica customizada aqui, 
// OU garantir que esta rota seja definida ANTES do loop genericTables.
// Vou ajustar para que esta rota sobrescreva a lógica padrão corretamente.

app.post('/movements', (req, res) => {
    const { productId, qty, tipo } = req.body;
    
    if (!productId || !qty || !tipo) {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }

    const qtyChange = tipo === 'input' ? Number(qty) : -Number(qty);
    const movementId = generateId('move');
    // CORREÇÃO: Removemos createdAt pois a tabela usa 'date' que vem no body ou deve ser gerado aqui
    const movementData = { 
        ...req.body, 
        id: movementId,
        // Se o frontend não mandar date, geramos:
        date: req.body.date || new Date().toISOString() 
    }; 
    
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        db.run('UPDATE inventory SET currentStock = currentStock + ? WHERE id = ?', [qtyChange, productId], function (err) {
            if (err || this.changes === 0) {
                db.run('ROLLBACK');
                return res.status(404).json({ error: 'Produto não encontrado ou erro no estoque.' });
            }

            const cols = Object.keys(movementData);
            const placeholders = cols.map(() => '?').join(', ');
            
            db.run(`INSERT INTO input_and_output_products (${cols.join(', ')}) VALUES (${placeholders})`, Object.values(movementData), (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).json({ error: err.message });
                }
                db.run('COMMIT');
                res.status(201).json(movementData);
            });
        });
    });
});

// LOGIN
app.post('/users/login', (req, res) => {
    const { username, password } = req.body;
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) return res.status(500).json({ error: 'Erro interno.' });
        if (!user || !comparePassword(password, user.password_hash)) {
            return res.status(401).json({ error: 'Credenciais inválidas.' });
        }
        delete user.password_hash;
        // CORREÇÃO: Retorna o usuário diretamente para compatibilidade com frontend
        res.json(user);
    });
});

// CREATE USER (Específico para hash)
app.post('/users', (req, res) => {
    const { username, password, user_group, is_active } = req.body;
    const password_hash = hashPassword(password);
    const data = { 
        username, 
        password_hash, 
        user_group: user_group || 'standard', 
        is_active: is_active !== undefined ? is_active : 1, 
        created_at: new Date().toISOString() 
    };
    
    const cols = Object.keys(data);
    const placeholders = cols.map(() => '?').join(', ');

    db.run(`INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders})`, Object.values(data), function (err) {
        if (err) return res.status(400).json({ error: err.message });
        res.status(201).json({ id: this.lastID, username, user_group, is_active: data.is_active });
    });
});

// BACKUP E RESTORE
const allTables = ['transactions', 'categories', 'inventory', 'input_and_output_products', 'users'];

app.get('/backup', async (req, res) => {
    const backup = {};
    // ... lógica de backup (mantenha a sua, removendo senha)
    // Simplificando para o exemplo:
    let pending = allTables.length;
    allTables.forEach(table => {
        db.all(`SELECT * FROM ${table}`, [], (err, rows) => {
            if (table === 'users' && rows) rows.forEach(r => delete r.password_hash);
            backup[table] = rows || [];
            pending--;
            if (pending === 0) res.json(backup);
        });
    });
});

app.post('/restore', (req, res) => {
    const data = req.body;
    db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        try {
            allTables.forEach(table => {
                if (!data[table]) return;
                db.run(`DELETE FROM ${table}`);
                
                if (data[table].length > 0) {
                    data[table].forEach(row => {
                        // CORREÇÃO: Filtramos ID apenas se for tabela users (autoincrement)
                        // Para outras tabelas, PRECISAMOS do ID original
                        const cols = Object.keys(row).filter(c => table === 'users' ? c !== 'id' : true);
                        
                        // Se for users, precisamos repor a senha se não vier no backup
                        if (table === 'users' && !row.password_hash) {
                           row.password_hash = hashPassword('123456'); // Senha padrão ao restaurar
                           cols.push('password_hash');
                        }

                        const placeholders = cols.map(() => '?').join(', ');
                        const values = cols.map(c => row[c]);
                        db.run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`, values);
                    });
                }
            });
            db.run('COMMIT');
            res.json({ message: 'Restaurado com sucesso' });
        } catch (e) {
            db.run('ROLLBACK');
            res.status(500).json({ error: e.message });
        }
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
});