const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==================== DATABASE ====================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

// ==================== DATABASE SETUP ====================

async function setupDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS groups (
            id VARCHAR(100) UNIQUE NOT NULL,
            groupname VARCHAR(255) NOT NULL,
            password VARCHAR(255),
            admin_email JSONB DEFAULT '[]'::jsonb,
            members_email JSONB DEFAULT '[]'::jsonb,
            purpus TEXT,
            short_discription TEXT,
            type VARCHAR(100) DEFAULT 'General Discussion',
            avatar TEXT,
            cover_photo TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await pool.query(`
        ALTER TABLE groups
            ADD COLUMN IF NOT EXISTS avatar TEXT,
            ADD COLUMN IF NOT EXISTS cover_photo TEXT,
            ADD COLUMN IF NOT EXISTS admin_email JSONB DEFAULT '[]'::jsonb,
            ADD COLUMN IF NOT EXISTS members_email JSONB DEFAULT '[]'::jsonb;
    `);

    console.log('Groups database setup completed.');
}

// ==================== HELPERS ====================

function normalizeEmail(email) {
    return typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';
}

function parseEmailList(value) {
    if (Array.isArray(value)) {
        return [...new Set(
            value
                .filter(item => typeof item === 'string')
                .map(item => normalizeEmail(item))
                .filter(Boolean)
        )];
    }

    if (typeof value === 'string' && value.trim()) {
        const text = value.trim();

        // JSON string array support
        try {
            const parsed = JSON.parse(text);

            if (Array.isArray(parsed)) {
                return parseEmailList(parsed);
            }
        } catch {
            // Treat as a single email or comma-separated list
        }

        return [...new Set(
            text.split(',')
                .map(item => normalizeEmail(item))
                .filter(Boolean)
        )];
    }

    return [];
}

// Validate HTTP / HTTPS image URLs
function isValidImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return false;
    }

    try {
        const url = new URL(value.trim());

        return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
}

// Validate Base64 and normal image URLs
function isValidImage(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return false;
    }

    const image = value.trim();

    const base64Match = image.match(
        /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i
    );

    if (base64Match) {
        const base64 = base64Match[2];

        return (
            base64.length > 0 &&
            base64.length % 4 === 0
        );
    }

    return isValidImageUrl(image);
}

// IMPORTANT:
// undefined, null and empty string are allowed.
// This lets the update route preserve or clear existing images.
function validOptionalImage(value) {
    if (value === undefined || value === null || value === '') {
        return true;
    }

    return isValidImage(value);
}

function getGroupAdmins(group) {
    return parseEmailList(group.admin_email);
}

function getGroupMembers(group) {
    return parseEmailList(group.members_email);
}

// ==================== 1. CREATE GROUP ====================

app.post('/api/groups', async (req, res) => {
    try {
        const {
            id,
            groupname,
            admin_email,
            purpus,
            short_discription,
            type,
            avatar,
            cover_photo
        } = req.body;

        if (
            typeof id !== 'string' ||
            !id.trim() ||
            typeof groupname !== 'string' ||
            !groupname.trim() ||
            !admin_email
        ) {
            return res.status(400).json({
                error: 'ID, Group Name, and Admin Email are required.'
            });
        }

        const groupId = id.trim();
        const name = groupname.trim();
        const adminEmail = normalizeEmail(admin_email);

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
            return res.status(400).json({
                error: 'A valid admin email is required.'
            });
        }

        if (name.length < 3 || name.length > 80) {
            return res.status(400).json({
                error: 'Group name must be between 3 and 80 characters.'
            });
        }

        if (
            !validOptionalImage(avatar) ||
            !validOptionalImage(cover_photo)
        ) {
            return res.status(400).json({
                error: 'Avatar and cover photo must be valid image URLs or supported Base64 images.'
            });
        }

        const admins = [adminEmail];
        const members = [adminEmail];

        const result = await pool.query(`
            INSERT INTO groups (
                id,
                groupname,
                admin_email,
                members_email,
                purpus,
                short_discription,
                type,
                avatar,
                cover_photo
            )
            VALUES (
                $1, $2, $3::jsonb, $4::jsonb,
                $5, $6, $7, $8, $9
            )
            RETURNING *;
        `, [
            groupId,
            name,
            JSON.stringify(admins),
            JSON.stringify(members),
            purpus || '',
            short_discription || '',
            type || 'General Discussion',
            avatar || null,
            cover_photo || null
        ]);

        return res.status(201).json({
            message: 'Group created successfully!',
            group: result.rows[0]
        });

    } catch (error) {
        console.error('Create group error:', error);

        if (error.code === '23505') {
            return res.status(409).json({
                error: 'This group ID already exists.'
            });
        }

        return res.status(500).json({
            error: 'Server error while creating group.'
        });
    }
});

// ==================== 2. GET ALL GROUPS ====================

app.get('/api/groups', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT *
            FROM groups
            ORDER BY created_at DESC;
        `);

        return res.json(result.rows);

    } catch (error) {
        console.error('Fetch groups error:', error);

        return res.status(500).json({
            error: 'Server error while fetching groups.'
        });
    }
});

// ==================== 3. SEARCH GROUPS ====================

app.get('/api/groups/search', async (req, res) => {
    try {
        const q = typeof req.query.q === 'string'
            ? req.query.q.trim()
            : '';

        if (!q) {
            return res.status(400).json({
                error: 'Search query parameter "q" is required.'
            });
        }

        const result = await pool.query(`
            SELECT *
            FROM groups
            WHERE groupname ILIKE $1
               OR purpus ILIKE $1
               OR short_discription ILIKE $1
               OR type ILIKE $1
            ORDER BY created_at DESC;
        `, [`%${q}%`]);

        return res.json(result.rows);

    } catch (error) {
        console.error('Search groups error:', error);

        return res.status(500).json({
            error: 'Server error while searching groups.'
        });
    }
});

// ==================== 4. GET GROUP BY ID ====================

app.get('/api/groups/:id', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM groups WHERE id = $1',
            [req.params.id]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        return res.json(result.rows[0]);

    } catch (error) {
        console.error('Get group error:', error);

        return res.status(500).json({
            error: 'Server error while fetching group.'
        });
    }
});

// ==================== 5. UPDATE GROUP ====================

app.put('/api/groups/:id', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const {
            email,
            groupname,
            purpus,
            short_discription,
            type,
            avatar,
            cover_photo
        } = req.body;

        const requesterEmail = normalizeEmail(email);

        if (!requesterEmail) {
            return res.status(400).json({
                error: 'Admin email is required.'
            });
        }

        // Validate images only if supplied
        if (
            !validOptionalImage(avatar) ||
            !validOptionalImage(cover_photo)
        ) {
            return res.status(400).json({
                error: 'Avatar and cover photo must be valid image URLs or supported Base64 images.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];
        const admins = getGroupAdmins(group);

        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                error: 'Only group admins can update this group.'
            });
        }

        const updatedName = groupname !== undefined
            ? String(groupname).trim()
            : group.groupname;

        if (updatedName.length < 3 || updatedName.length > 80) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                error: 'Group name must be between 3 and 80 characters.'
            });
        }

        const updatedPurpus = purpus !== undefined
            ? purpus
            : group.purpus;

        const updatedDescription = short_discription !== undefined
            ? short_discription
            : group.short_discription;

        const updatedType = type !== undefined
            ? type
            : group.type;

        // undefined = preserve old image
        // null or '' = clear image
        const updatedAvatar = avatar !== undefined
            ? (avatar || null)
            : group.avatar;

        const updatedCover = cover_photo !== undefined
            ? (cover_photo || null)
            : group.cover_photo;

        const result = await client.query(`
            UPDATE groups
            SET groupname = $1,
                purpus = $2,
                short_discription = $3,
                type = $4,
                avatar = $5,
                cover_photo = $6
            WHERE id = $7
            RETURNING *;
        `, [
            updatedName,
            updatedPurpus,
            updatedDescription,
            updatedType,
            updatedAvatar,
            updatedCover,
            req.params.id
        ]);

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'Group updated successfully!',
            group: result.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Update group error:', error);

        return res.status(500).json({
            error: 'Server error while updating group.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== 6. JOIN GROUP ====================

app.post('/api/groups/:id/join', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'User email is required.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];
        const members = getGroupMembers(group);
        const admins = getGroupAdmins(group);

        if (members.includes(email) || admins.includes(email)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(409).json({
                error: 'User is already a member of this group.'
            });
        }

        members.push(email);

        const result = await client.query(`
            UPDATE groups
            SET members_email = $1::jsonb
            WHERE id = $2
            RETURNING *;
        `, [
            JSON.stringify(members),
            req.params.id
        ]);

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'Successfully joined the group!',
            group: result.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Join group error:', error);

        return res.status(500).json({
            error: 'Server error while joining group.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== 7. LEAVE GROUP ====================

app.post('/api/groups/:id/leave', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'User email is required.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];

        const members = getGroupMembers(group);
        const admins = getGroupAdmins(group);

        if (!members.includes(email) && !admins.includes(email)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                error: 'User is not a member of this group.'
            });
        }

        if (admins.includes(email) && admins.length <= 1) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                error: 'The sole admin must promote another admin before leaving.'
            });
        }

        const updatedMembers = members.filter(
            member => member !== email
        );

        const updatedAdmins = admins.filter(
            admin => admin !== email
        );

        const result = await client.query(`
            UPDATE groups
            SET members_email = $1::jsonb,
                admin_email = $2::jsonb
            WHERE id = $3
            RETURNING *;
        `, [
            JSON.stringify(updatedMembers),
            JSON.stringify(updatedAdmins),
            req.params.id
        ]);

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'Successfully left the group.',
            group: result.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Leave group error:', error);

        return res.status(500).json({
            error: 'Server error while leaving group.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== 8. DELETE GROUP ====================

app.delete('/api/groups/:id', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'Admin email is required.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const admins = getGroupAdmins(groupResult.rows[0]);

        if (!admins.includes(email)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                error: 'Only group admins can delete this group.'
            });
        }

        await client.query(
            'DELETE FROM groups WHERE id = $1',
            [req.params.id]
        );

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'Group deleted successfully.'
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Delete group error:', error);

        return res.status(500).json({
            error: 'Server error while deleting group.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== 9. PROMOTE MEMBER TO ADMIN ====================

app.post('/api/groups/:id/promote-admin', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const groupId = req.params.id;

        const requesterEmail = normalizeEmail(req.body.email);
        const promoteEmail = normalizeEmail(req.body.promote_email);

        if (!requesterEmail || !promoteEmail) {
            return res.status(400).json({
                success: false,
                message: 'Both emails are required.'
            });
        }

        if (requesterEmail === promoteEmail) {
            return res.status(400).json({
                success: false,
                message: 'You cannot promote yourself.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const result = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [groupId]
        );

        if (!result.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                success: false,
                message: 'Group not found.'
            });
        }

        const group = result.rows[0];

        const admins = getGroupAdmins(group);
        const members = getGroupMembers(group);

        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                success: false,
                message: 'Only group admins can promote members.'
            });
        }

        if (!members.includes(promoteEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message: 'This user is not a group member.'
            });
        }

        if (admins.includes(promoteEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(409).json({
                success: false,
                message: 'This user is already an admin.'
            });
        }

        const updatedAdmins = [
            ...admins,
            promoteEmail
        ];

        const updatedMembers = members.filter(
            email => email !== promoteEmail
        );

        const updateResult = await client.query(`
            UPDATE groups
            SET admin_email = $1::jsonb,
                members_email = $2::jsonb
            WHERE id = $3
            RETURNING *;
        `, [
            JSON.stringify(updatedAdmins),
            JSON.stringify(updatedMembers),
            groupId
        ]);

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'Member successfully promoted to admin.',
            group: updateResult.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Promote admin error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== 10. LEAVE ADMIN ROLE ====================

app.post('/api/groups/:id/leave-admin', async (req, res) => {
    let client;
    let transactionStarted = false;

    try {
        client = await pool.connect();

        const groupId = req.params.id;
        const requesterEmail = normalizeEmail(req.body.email);

        if (!requesterEmail) {
            return res.status(400).json({
                success: false,
                message: 'Email is required.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        const result = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [groupId]
        );

        if (!result.rows.length) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(404).json({
                success: false,
                message: 'Group not found.'
            });
        }

        const group = result.rows[0];

        const admins = getGroupAdmins(group);
        const members = getGroupMembers(group);

        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                success: false,
                message: 'You are not an admin of this group.'
            });
        }

        if (admins.length <= 1) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message: 'You cannot leave because you are the only admin. Promote another member first.'
            });
        }

        const updatedAdmins = admins.filter(
            email => email !== requesterEmail
        );

        const updatedMembers = [
            ...members.filter(email => email !== requesterEmail),
            requesterEmail
        ];

        const updateResult = await client.query(`
            UPDATE groups
            SET admin_email = $1::jsonb,
                members_email = $2::jsonb
            WHERE id = $3
            RETURNING *;
        `, [
            JSON.stringify(updatedAdmins),
            JSON.stringify(updatedMembers),
            groupId
        ]);

        await client.query('COMMIT');
        transactionStarted = false;

        return res.json({
            success: true,
            message: 'You have successfully left the admin role.',
            group: updateResult.rows[0]
        });

    } catch (error) {
        if (client && transactionStarted) {
            await client.query('ROLLBACK').catch(() => {});
        }

        console.error('Leave admin error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });

    } finally {
        if (client) client.release();
    }
});

// ==================== SERVER ERROR HANDLER ====================

app.use((error, req, res, next) => {
    console.error('Express error:', error);

    if (error.type === 'entity.too.large') {
        return res.status(413).json({
            error: 'Uploaded data is too large. Please use a smaller image.'
        });
    }

    return res.status(500).json({
        error: 'Internal server error.'
    });
});

// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

async function startServer() {
    try {
        await setupDatabase();

        app.listen(PORT, () => {
            console.log(`AsirNet Group API running on port ${PORT}`);
        });

    } catch (error) {
        console.error('Server startup failed:', error);
        process.exit(1);
    }
}

startServer();
