import {
  listWebUsers,
  updateWebUser,
  getWebUserById,
  deleteWebUser,
  deleteAccountData,
  setCors,
  verifyWebSessionToken,
  getSessionFromReq,
} from "../lib/db.js";

// Panel ADMIN untuk mengelola akun web (bukan lisensi EA).
//
// GET    -> daftar semua akun web
// POST   -> update satu akun web: approve/reject, atau mengaitkan ke
//           satu account_login (Nomor Akun MT5).
// DELETE -> hapus PERMANEN satu akun web + data akun EA/lisensi
//           terkaitnya (khusus admin). Setelah dihapus, email tsb
//           tidak bisa login lagi dan harus daftar ulang dari nol.
//
// PENTING: endpoint ini TIDAK membuat/menghasilkan kode lisensi EA.
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = getSessionFromReq(req);
  const session = verifyWebSessionToken(token);
  if (!session || session.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Akses ditolak — khusus admin" });
  }

  try {
    if (req.method === "GET") {
      const users = await listWebUsers();
      return res.status(200).json({ ok: true, users });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const id = Number(body.id);
      if (!id) return res.status(400).json({ ok: false, error: "Parameter 'id' wajib diisi" });

      const target = await getWebUserById(id);
      if (!target) return res.status(404).json({ ok: false, error: "Akun tidak ditemukan" });

      const patch = {};
      if (body.status && ["pending", "approved"].includes(body.status)) {
        patch.status = body.status;
      }
      if (typeof body.accountLogin === "string") {
        patch.account_login = body.accountLogin.trim() || null;
      }
      if (body.role && ["user", "admin"].includes(body.role)) {
        patch.role = body.role;
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ ok: false, error: "Tidak ada perubahan yang dikirim" });
      }

      const updated = await updateWebUser(id, patch);
      return res.status(200).json({ ok: true, user: updated });
    }

    if (req.method === "DELETE") {
      const body = req.body || {};
      const id = Number(body.id ?? req.query?.id);
      if (!id) return res.status(400).json({ ok: false, error: "Parameter 'id' wajib diisi" });

      const target = await getWebUserById(id);
      if (!target) return res.status(404).json({ ok: false, error: "Akun tidak ditemukan" });

      // Jangan biarkan admin tidak sengaja menghapus akun admin lain
      // (termasuk dirinya sendiri) lewat panel ini — cegah lockout.
      if (target.role === "admin") {
        return res.status(400).json({ ok: false, error: "Tidak bisa menghapus akun admin dari panel ini" });
      }

      const accountLogin = target.account_login;

      // Hapus data akun EA/lisensi (accounts + journal_entries; ea_logs
      // ikut terhapus otomatis via ON DELETE CASCADE) SEBELUM menghapus
      // baris web_users, supaya kalau langkah ini gagal, akun web tetap
      // konsisten (tidak setengah terhapus).
      if (accountLogin) {
        await deleteAccountData(accountLogin);
      }
      await deleteWebUser(id);

      return res.status(200).json({ ok: true, deletedId: id, accountLogin: accountLogin || null });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
