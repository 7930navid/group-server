const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// ==================== DATABASE CONNECTION STRING ====================
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: true } // রিমোট ডাটাবেসের জন্য প্রয়োজন হলে আনকমেন্ট করুন
});

// ==================== AUTO DB SETUP FUNCTION ====================
async function setupDatabase() {
    try {
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS groups (
                id VARCHAR(100) UNIQUE NOT NULL,
                groupname VARCHAR(255) NOT NULL,
                password VARCHAR(255),
                admin_email JSONB DEFAULT '[]'::jsonb,
                members_email JSONB DEFAULT '[]'::jsonb,
                purpus TEXT,
                short_discription TEXT,
                type VARCHAR(50) DEFAULT 'group',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;

        await pool.query(createTableQuery);
        console.log('Database table "groups" checked / created successfully!');
    } catch (err) {
        console.error('Error setting up database table:', err.stack);
        process.exit(1);
    }
}

// ==================== GROUP ROUTES ====================

// 1. Create a New Group
app.post('/api/groups', async (req, res) => {
    try {
        const { id, groupname, password, admin_email, purpus, short_discription, type } = req.body;

        if (!id || !groupname || !admin_email) {
            return res.status(400).json({ error: 'ID, Group Name, and Admin Email are required!' });
        }

        const initialMembers = Array.isArray(admin_email) ? admin_email : [admin_email];
        const adminsArray = Array.isArray(admin_email) ? admin_email : [admin_email];

        const query = `
            INSERT INTO groups (id, groupname, password, admin_email, members_email, purpus, short_discription, type)
            VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
            RETURNING *;
        `;

        const values = [
            id,
            groupname,
            password || null,
            JSON.stringify(adminsArray),
            JSON.stringify(initialMembers),
            purpus || '',
            short_discription || '',
            type || 'group'
        ];

        const result = await pool.query(query, values);
        res.status(201).json({ message: 'Group created successfully!', group: result.rows[0] });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while creating group' });
    }
});

// 2. Get All Groups
app.get('/api/groups', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM groups ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while fetching groups' });
    }
});

// 3. Search Groups (Query parameter: ?q=keyword)
app.get('/api/groups/search', async (req, res) => {
    try {
        const { q } = req.query;
        if (!q) {
            return res.status(400).json({ error: 'Search query parameter "q" is required!' });
        }

        const searchTerm = `%${q}%`;
        const query = `
            SELECT * FROM groups
            WHERE groupname ILIKE $1 OR purpus ILIKE $1 OR short_discription ILIKE $1
            ORDER BY created_at DESC;
        `;

        const result = await pool.query(query, [searchTerm]);
        res.json(result.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while searching groups' });
    }
});

// 4. Get Single Group Details by ID
app.get('/api/groups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found!' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while fetching group' });
    }
});

// 5. Edit / Update Group Details & Promote Member to Admin (Admin Only)
app.put('/api/groups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, groupname, password, purpus, short_discription, type, promote_email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Admin email is required to update the group!' });
        }

        const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
        if (groupResult.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found!' });
        }

        let group = groupResult.rows[0];
        let admins = group.admin_email || [];
        let members = group.members_email || [];

        // Verify if requester is an admin
        if (!admins.includes(email)) {
            return res.status(403).json({ error: 'Unauthorized! Only group admins can update group details.' });
        }

        // Optional: Promote any existing group member to admin
        if (promote_email) {
            if (!members.includes(promote_email)) {
                return res.status(400).json({ error: 'User must be a member of the group before being promoted to admin!' });
            }
            if (!admins.includes(promote_email)) {
                admins.push(promote_email);
            }
        }

        const updatedGroupname = groupname !== undefined ? groupname : group.groupname;
        const updatedPassword = password !== undefined ? password : group.password;
        const updatedPurpus = purpus !== undefined ? purpus : group.purpus;
        const updatedShortDesc = short_discription !== undefined ? short_discription : group.short_discription;
        const updatedType = type !== undefined ? type : group.type;

        const updateQuery = `
            UPDATE groups
            SET groupname = $1, password = $2, purpus = $3, short_discription = $4, type = $5, admin_email = $6::jsonb
            WHERE id = $7
            RETURNING *;
        `;

        const values = [
            updatedGroupname,
            updatedPassword,
            updatedPurpus,
            updatedShortDesc,
            updatedType,
            JSON.stringify(admins),
            id
        ];

        const updateResult = await pool.query(updateQuery, values);
        res.json({ message: 'Group updated successfully!', group: updateResult.rows[0] });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while updating group' });
    }
});

// 6. Join a Group
app.post('/api/groups/:id/join', async (req, res) => {
    try {
        const { id } = req.params;
        const { email, password } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'User email is required to join!' });
        }

        const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
        if (groupResult.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found!' });
        }

        const group = groupResult.rows[0];

        if (group.password && group.password !== password) {
            return res.status(401).json({ error: 'Incorrect group password!' });
        }

        const members = group.members_email || [];

        if (members.includes(email)) {
            return res.status(400).json({ message: 'User is already a member of this group.' });
        }

        members.push(email);

        const updateQuery = `
            UPDATE groups
            SET members_email = $1::jsonb
            WHERE id = $2
            RETURNING *;
        `;

        const updateResult = await pool.query(updateQuery, [JSON.stringify(members), id]);

        res.json({ message: 'Successfully joined the group!', group: updateResult.rows[0] });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while joining group' });
    }
});

// 7. Leave a Group (Admin Leave restriction implemented)
app.post('/api/groups/:id/leave', async (req, res) => {
    try {
        const { id } = req.params;
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'User email is required!' });
        }

        const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
        if (groupResult.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found!' });
        }

        let group = groupResult.rows[0];
        let members = group.members_email || [];
        let admins = group.admin_email || [];

        if (!members.includes(email) && !admins.includes(email)) {
            return res.status(400).json({ error: 'User is not a member of this group!' });
        }

        // Rule: If user is an admin, they cannot leave if they are the sole admin.
        // They must first promote someone else to admin using the Edit route.
        if (admins.includes(email)) {
            if (admins.length === 1) {
                return res.status(400).json({ error: 'You are the sole admin! You cannot leave the group until you promote another member to admin.' });
            }
            // If multiple admins exist, remove from admin list too
            admins = admins.filter(a => email !== a);
        }

        members = members.filter(m => email !== m);

        const updateQuery = `
            UPDATE groups
            SET members_email = $1::jsonb, admin_email = $2::jsonb
            WHERE id = $3
            RETURNING *;
        `;

        const updateResult = await pool.query(updateQuery, [
            JSON.stringify(members),
            JSON.stringify(admins),
            id
        ]);

        res.json({ message: 'Successfully left the group.', group: updateResult.rows[0] });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while leaving group' });
    }
});

// 8. Delete Group (Admin Only)
app.delete('/api/groups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: 'Admin email is required!' });
        }

        const groupResult = await pool.query('SELECT * FROM groups WHERE id = $1', [id]);
        if (groupResult.rows.length === 0) {
            return res.status(404).json({ error: 'Group not found!' });
        }

        const group = groupResult.rows[0];
        const admins = group.admin_email || [];

        if (!admins.includes(email)) {
            return res.status(403).json({ error: 'Unauthorized! Only group admins can delete this group.' });
        }

        await pool.query('DELETE FROM groups WHERE id = $1', [id]);
        res.json({ message: 'Group deleted successfully.' });

    } catch (err) {
        console.error(err.message);
        res.status(500).json({ error: 'Server error while deleting group' });
    }
});

// ==================== START SERVER & AUTO SETUP ====================
const PORT = process.env.PORT || 5000;

async function startServer() {
    await setupDatabase();

    app.listen(PORT, () => {
        console.log(`AsirNet Group API Server running on port ${PORT}`);
    });
}

startServer();