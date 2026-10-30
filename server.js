
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
    try {
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

        // Existing database compatibility
        await pool.query(`
            ALTER TABLE groups
                ADD COLUMN IF NOT EXISTS avatar TEXT,
                ADD COLUMN IF NOT EXISTS cover_photo TEXT;
        `);

        console.log('Groups database setup completed.');
    } catch (error) {
        console.error('Database setup error:', error);
        process.exit(1);
    }
}

// ==================== HELPERS ====================

function normalizeEmail(email) {
    return typeof email === 'string'
        ? email.trim().toLowerCase()
        : '';
}

function parseEmailList(value) {
    if (Array.isArray(value)) {
        return value
            .filter(item => typeof item === 'string')
            .map(item => item.trim().toLowerCase())
            .filter(Boolean);
    }

    if (typeof value === 'string' && value.trim()) {
        return [value.trim().toLowerCase()];
    }

    return [];
}

function isValidImageUrl(value) {
    if (typeof value !== 'string' || !value.trim()) {
        return false;
    }

    try {
        const url = new URL(value);

        return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password
        );
    } catch {
        return false;
    }
}

function isValidImage(value) {
    if (typeof value !== "string" || !value.trim()) {
        return false;
    }

    const image = value.trim();

    // Base64 image support
    const base64Match = image.match(
        /^data:image\/(jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/
    );

    if (base64Match) {
        const base64 = base64Match[2];

        return (
            base64.length > 0 &&
            base64.length % 4 === 0
        );
    }

    // Normal HTTP/HTTPS image URL support
    try {
        const url = new URL(image);

        return (
            url.protocol === "http:" ||
            url.protocol === "https:"
        );
    } catch {
        return false;
    }
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

        if (!adminEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
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
    !isValidImage(avatar) ||
    !isValidImage(cover_photo)
) {
    return res.status(400).json({
        error: "Avatar and cover photo must be valid image URLs or supported Base64 images."
    });
}
        const admins = [adminEmail];
        const members = [adminEmail];

        const query = `
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
        `;

        const values = [
            groupId,
            name,
            JSON.stringify(admins),
            JSON.stringify(members),
            purpus || '',
            short_discription || '',
            type || 'Other',
            avatar || null,
            cover_photo || null
        ];

        const result = await pool.query(query, values);

        return res.status(201).json({
            message: 'Group created successfully!',
            group: result.rows[0]
        });

    } catch (error) {
        console.error('Create group error:', error.message);

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
        console.error('Fetch groups error:', error.message);

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

        const searchTerm = `%${q}%`;

        const result = await pool.query(`
            SELECT *
            FROM groups
            WHERE groupname ILIKE $1
               OR purpus ILIKE $1
               OR short_discription ILIKE $1
               OR type ILIKE $1
            ORDER BY created_at DESC;
        `, [searchTerm]);

        return res.json(result.rows);
    } catch (error) {
        console.error('Search groups error:', error.message);

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
        console.error('Get group error:', error.message);

        return res.status(500).json({
            error: 'Server error while fetching group.'
        });
    }
});

// ==================== 5. UPDATE GROUP / PROMOTE ADMIN ====================

app.put('/api/groups/:id', async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            email,
            groupname,
            purpus,
            short_discription,
            type,
            avatar,
            cover_photo,
            promote_email
        } = req.body;

        const requesterEmail = normalizeEmail(email);

        if (!requesterEmail) {
            return res.status(400).json({
                error: 'Admin email is required.'
            });
        }

        if (
            !validOptionalImage(avatar) ||
            !validOptionalImage(cover_photo)
        ) {
            return res.status(400).json({
                error: 'Avatar and cover photo must be valid image URLs.'
            });
        }

        await client.query('BEGIN');

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];
        const admins = parseEmailList(group.admin_email);
        const members = parseEmailList(group.members_email);

        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'Only group admins can update this group.'
            });
        }

        if (promote_email) {
            const promoteEmail = normalizeEmail(promote_email);

            if (!members.includes(promoteEmail)) {
                await client.query('ROLLBACK');

                return res.status(400).json({
                    error: 'The user must join the group before promotion.'
                });
            }

            if (!admins.includes(promoteEmail)) {
                admins.push(promoteEmail);
            }
        }

        const updatedName = groupname !== undefined
            ? String(groupname).trim()
            : group.groupname;

        if (updatedName.length < 3 || updatedName.length > 80) {
            await client.query('ROLLBACK');

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
                cover_photo = $6,
                admin_email = $7::jsonb
            WHERE id = $8
            RETURNING *;
        `, [
            updatedName,
            updatedPurpus,
            updatedDescription,
            updatedType,
            updatedAvatar,
            updatedCover,
            JSON.stringify(admins),
            req.params.id
        ]);

        await client.query('COMMIT');

        return res.json({
            message: 'Group updated successfully!',
            group: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Update group error:', error.message);

        return res.status(500).json({
            error: 'Server error while updating group.'
        });
    } finally {
        client.release();
    }
});

// ==================== 6. JOIN GROUP ====================
// No group password is required.

app.post('/api/groups/:id/join', async (req, res) => {
    const client = await pool.connect();

    try {
        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'User email is required.'
            });
        }

        await client.query('BEGIN');

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];
        const members = parseEmailList(group.members_email);

        if (members.includes(email)) {
            await client.query('ROLLBACK');

            return res.status(409).json({
                message: 'User is already a member of this group.'
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

        return res.json({
            message: 'Successfully joined the group!',
            group: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Join group error:', error.message);

        return res.status(500).json({
            error: 'Server error while joining group.'
        });
    } finally {
        client.release();
    }
});

// ==================== 7. LEAVE GROUP ====================

app.post('/api/groups/:id/leave', async (req, res) => {
    const client = await pool.connect();

    try {
        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'User email is required.'
            });
        }

        await client.query('BEGIN');

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];

        let members = parseEmailList(group.members_email);
        let admins = parseEmailList(group.admin_email);

        if (!members.includes(email) && !admins.includes(email)) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                error: 'User is not a member of this group.'
            });
        }

        if (admins.includes(email) && admins.length === 1) {
            await client.query('ROLLBACK');

            return res.status(400).json({
                error: 'The sole admin must promote another admin before leaving.'
            });
        }

        members = members.filter(member => member !== email);
        admins = admins.filter(admin => admin !== email);

        const result = await client.query(`
            UPDATE groups
            SET members_email = $1::jsonb,
                admin_email = $2::jsonb
            WHERE id = $3
            RETURNING *;
        `, [
            JSON.stringify(members),
            JSON.stringify(admins),
            req.params.id
        ]);

        await client.query('COMMIT');

        return res.json({
            message: 'Successfully left the group.',
            group: result.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Leave group error:', error.message);

        return res.status(500).json({
            error: 'Server error while leaving group.'
        });
    } finally {
        client.release();
    }
});

// ==================== 8. DELETE GROUP (ADMIN ONLY) ====================

app.delete('/api/groups/:id', async (req, res) => {
    const client = await pool.connect();

    try {
        const email = normalizeEmail(req.body.email);

        if (!email) {
            return res.status(400).json({
                error: 'Admin email is required.'
            });
        }

        await client.query('BEGIN');

        const groupResult = await client.query(
            'SELECT * FROM groups WHERE id = $1 FOR UPDATE',
            [req.params.id]
        );

        if (!groupResult.rows.length) {
            await client.query('ROLLBACK');

            return res.status(404).json({
                error: 'Group not found.'
            });
        }

        const group = groupResult.rows[0];
        const admins = parseEmailList(group.admin_email);

        if (!admins.includes(email)) {
            await client.query('ROLLBACK');

            return res.status(403).json({
                error: 'Only group admins can delete this group.'
            });
        }

        await client.query(
            'DELETE FROM groups WHERE id = $1',
            [req.params.id]
        );

        await client.query('COMMIT');

        return res.json({
            message: 'Group deleted successfully.'
        });

    } catch (error) {
        await client.query('ROLLBACK');

        console.error('Delete group error:', error.message);

        return res.status(500).json({
            error: 'Server error while deleting group.'
        });
    } finally {
        client.release();
    }
});


// =====================================================
 // PROMOTE GROUP MEMBER TO ADMIN
 // =====================================================

app.post('/api/groups/:id/promote-admin', async (req, res) => {
    const client = await pool.connect();

    let transactionStarted = false;

    try {
        const groupId = req.params.id;

        const { email, promote_email } = req.body;

        const requesterEmail = String(email || '').trim().toLowerCase();
        const promoteEmail = String(promote_email || '').trim().toLowerCase();

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

        // Fetch group with row lock
        const result = await client.query(
            `SELECT * FROM groups
             WHERE id = $1
             FOR UPDATE`,
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

        // Parse JSON / JSONB arrays
        const admins = Array.isArray(group.admin_email)
            ? group.admin_email.map(e => String(e).trim().toLowerCase())
            : [];

        const members = Array.isArray(group.members_email)
            ? group.members_email.map(e => String(e).trim().toLowerCase())
            : [];

        // Check requester admin permission
        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                success: false,
                message: 'Only group admins can promote members.'
            });
        }

        // Check target membership
        if (!members.includes(promoteEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message: 'This user is not a group member.'
            });
        }

        // Already admin?
        if (admins.includes(promoteEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(409).json({
                success: false,
                message: 'This user is already an admin.'
            });
        }

        // Add new admin
        const updatedAdmins = [
            ...admins,
            promoteEmail
        ];

        // Remove from members
        const updatedMembers = members.filter(
            e => e !== promoteEmail
        );

        // Update database
        // JSON.stringify supports both JSON and JSONB columns
        const updateResult = await client.query(
            `UPDATE groups
             SET admin_email = $1,
                 members_email = $2
             WHERE id = $3
             RETURNING *`,
            [
                JSON.stringify(updatedAdmins),
                JSON.stringify(updatedMembers),
                groupId
            ]
        );

        await client.query('COMMIT');
        transactionStarted = false;

        return res.status(200).json({
            success: true,
            message: 'Member successfully promoted to admin.',
            group: updateResult.rows[0]
        });

    } catch (error) {

        if (transactionStarted) {
            await client.query('ROLLBACK');
        }

        console.error('Promote admin error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });

    } finally {
        client.release();
    }
});


// =====================================================
 // LEAVE GROUP ADMIN ROLE
 // =====================================================

app.post('/api/groups/:id/leave-admin', async (req, res) => {
    const client = await pool.connect();

    let transactionStarted = false;

    try {
        const groupId = req.params.id;

        const requesterEmail = String(
            req.body.email || ''
        ).trim().toLowerCase();

        if (!requesterEmail) {
            return res.status(400).json({
                success: false,
                message: 'Email is required.'
            });
        }

        await client.query('BEGIN');
        transactionStarted = true;

        // Fetch group with row lock
        const result = await client.query(
            `SELECT * FROM groups
             WHERE id = $1
             FOR UPDATE`,
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

        // Parse JSON / JSONB arrays
        const admins = Array.isArray(group.admin_email)
            ? group.admin_email.map(e => String(e).trim().toLowerCase())
            : [];

        const members = Array.isArray(group.members_email)
            ? group.members_email.map(e => String(e).trim().toLowerCase())
            : [];

        // Check admin permission
        if (!admins.includes(requesterEmail)) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(403).json({
                success: false,
                message: 'You are not an admin of this group.'
            });
        }

        // Prevent last admin from leaving
        if (admins.length <= 1) {
            await client.query('ROLLBACK');
            transactionStarted = false;

            return res.status(400).json({
                success: false,
                message: 'You cannot leave because you are the only admin. Promote another member first.'
            });
        }

        // Remove requester from admins
        const updatedAdmins = admins.filter(
            e => e !== requesterEmail
        );

        // Return requester to members
        const updatedMembers = [
            ...members.filter(e => e !== requesterEmail),
            requesterEmail
        ];

        // Update database
        const updateResult = await client.query(
            `UPDATE groups
             SET admin_email = $1,
                 members_email = $2
             WHERE id = $3
             RETURNING *`,
            [
                JSON.stringify(updatedAdmins),
                JSON.stringify(updatedMembers),
                groupId
            ]
        );

        await client.query('COMMIT');
        transactionStarted = false;

        return res.status(200).json({
            success: true,
            message: 'You have successfully left the admin role.',
            group: updateResult.rows[0]
        });

    } catch (error) {

        if (transactionStarted) {
            await client.query('ROLLBACK');
        }

        console.error('Leave admin error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error.'
        });

    } finally {
        client.release();
    }
});


// ==================== START SERVER ====================

const PORT = process.env.PORT || 5000;

async function startServer() {
    await setupDatabase();

    app.listen(PORT, () => {
        console.log(`AsirNet Group API running on port ${PORT}`);
    });
}

startServer().catch(error => {
    console.error('Server startup failed:', error);
    process.exit(1);
});
