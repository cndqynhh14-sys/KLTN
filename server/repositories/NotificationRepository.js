'use strict';

class NotificationRepository {
  constructor(db) {
    this.db = db;
    this.statements = {
      insert: db.prepare(`
        INSERT OR IGNORE INTO notifications (
          receiver_user_id, sender_user_id, ticket_id, notification_type,
          title, message, payload_json, unique_key
        ) VALUES (
          @receiver_user_id, @sender_user_id, @ticket_id, @notification_type,
          @title, @message, @payload_json, @unique_key
        )
      `),
      allByReceiver: db.prepare(`
        SELECT n.*, t.ticket_code, t.supplier_code, t.supplier_name
        FROM notifications n
        LEFT JOIN evaluation_tickets t ON t.id = n.ticket_id
        WHERE n.receiver_user_id = ?
        ORDER BY n.created_at DESC, n.id DESC
      `),
      getForReceiver: db.prepare(`
        SELECT n.*, t.ticket_code, t.supplier_code, t.supplier_name
        FROM notifications n
        LEFT JOIN evaluation_tickets t ON t.id = n.ticket_id
        WHERE n.id = ? AND n.receiver_user_id = ?
      `),
      markRead: db.prepare(`
        UPDATE notifications
        SET is_read = 1, read_at = COALESCE(read_at, datetime('now'))
        WHERE id = ? AND receiver_user_id = ?
      `),
      evaluationById: db.prepare(`SELECT * FROM evaluation_tickets WHERE id = ? AND COALESCE(is_deleted, 0) = 0`),
      activeUser: db.prepare(`SELECT * FROM users WHERE (user_id = ? OR lower(email) = lower(?)) AND is_active = 1`),
      deadlineCandidates: db.prepare(`
        WITH round_2_due AS (
          SELECT t.id AS ticket_id, MAX(date(nc.due_date)) AS due_date
          FROM evaluation_tickets t
          JOIN evaluation_nonconformities nc ON nc.ticket_id = t.id
          WHERE t.current_status = @waiting_correction
            AND COALESCE(t.is_deleted, 0) = 0
            AND NULLIF(TRIM(COALESCE(nc.due_date, '')), '') IS NOT NULL
            AND nc.severity IN ('B', 'C', 'D')
            AND nc.status != 'CANCELLED'
            AND NOT EXISTS (
              SELECT 1 FROM evaluation_rounds r2
              WHERE r2.ticket_id = t.id AND r2.round_no = 2
            )
          GROUP BY t.id
        )
        SELECT t.*, 1 AS deadline_round, date(t.planned_date) AS deadline_date
        FROM evaluation_tickets t
        WHERE COALESCE(t.is_deleted, 0) = 0
          AND COALESCE(t.completed_round, 0) < 1
          AND NULLIF(TRIM(COALESCE(t.planned_date, '')), '') IS NOT NULL
          AND t.current_status NOT IN (@completed, @cancelled, @suspended)
        UNION ALL
        SELECT t.*, 2 AS deadline_round, r2.due_date AS deadline_date
        FROM round_2_due r2
        JOIN evaluation_tickets t ON t.id = r2.ticket_id
      `),
    };
  }

  insert(payload) { return this.statements.insert.run(payload); }
  allByReceiver(receiverUserId) { return this.statements.allByReceiver.all(receiverUserId); }
  getForReceiver(id, receiverUserId) { return this.statements.getForReceiver.get(id, receiverUserId); }
  markRead(id, receiverUserId) { return this.statements.markRead.run(id, receiverUserId); }
  evaluationById(id) { return this.statements.evaluationById.get(id); }
  activeUser(identifier) { return this.statements.activeUser.get(identifier, identifier); }
  deadlineCandidates(statuses) { return this.statements.deadlineCandidates.all(statuses); }
}

module.exports = NotificationRepository;
