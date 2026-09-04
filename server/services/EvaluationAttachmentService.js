const path = require('path');
const { resolveUserId } = require('../domain/userIdentity');

class EvaluationAttachmentService {
  constructor({
    db,
    attachmentRepository,
    answerRepository,
    removeLocalFile,
    mapAttachment,
  }) {
    this.db = db;
    this.attachmentRepository = attachmentRepository;
    this.answerRepository = answerRepository;
    this.removeLocalFile = removeLocalFile;
    this.mapAttachment = mapAttachment;
  }

  listForTicket(ticketId) {
    const seen = new Set();
    return this.attachmentRepository.listForTicket(ticketId)
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      });
  }

  attachLegalFiles(ticketId, files, userEmail) {
    const entries = [
      ['business_license', files?.business_license_file?.[0]],
      ['attp_certificate', files?.attp_certificate_file?.[0]],
    ].filter(([, file]) => !!file);
    if (!entries.length) return {};

    const saved = {};
    const actorUserId = resolveUserId(this.db, userEmail, { required: true });
    this.db.transaction(() => {
      entries.forEach(([kind, file]) => {
        const previous = this.attachmentRepository.listLegalByKind(ticketId, kind);
        previous.forEach((row) => this.removeLocalFile(row.file_path));
        this.attachmentRepository.deleteLegalByKind(ticketId, kind);
        const storageKey = `LEGAL:${kind}:${path.basename(file.path)}`;
        const info = this.attachmentRepository.insert({
          answer_id: null,
          ticket_id: ticketId,
          file_name: file.originalname,
          file_path: file.path,
          storage_key: storageKey,
          mime_type: file.mimetype,
          size_bytes: file.size,
          uploaded_by: actorUserId,
        });
        saved[kind] = { id: info.lastInsertRowid, file_name: file.originalname };
      });
    })();
    return saved;
  }

  uploadAnswerAttachment({ ticket, round, questionId, file, user }) {
    return this.db.transaction(() => {
      const actorUserId = resolveUserId(this.db, user?.userId || user?.user_id || user?.email, { required: true });
      this.answerRepository.insertBlankIfMissing(round.id, questionId, actorUserId);
      const answer = this.answerRepository.getByRoundAndQuestion(round.id, questionId);
      const info = this.attachmentRepository.insert({
        answer_id: answer.id,
        ticket_id: ticket.id,
        file_name: file.originalname,
        file_path: file.path,
        storage_key: path.basename(file.path),
        mime_type: file.mimetype,
        size_bytes: file.size,
        uploaded_by: actorUserId,
      });
      const attachment = this.attachmentRepository.getById(info.lastInsertRowid);
      return { answer, attachment: this.mapAttachment(attachment) };
    })();
  }

  getDownloadAttachment(id) {
    return this.attachmentRepository.getById(id);
  }
}

module.exports = EvaluationAttachmentService;
