import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { supabase } from './supabaseClient.js';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

// --- 1. AUTHENTICATION ---
// Register User
app.post('/api/auth/register', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Registrasi berhasil', user: data.user });
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(400).json({ error: error.message });
  res.json({ token: data.session.access_token, user: data.user });
});

// --- 2. MANAGEMENT STORES (MULTI-TENANT) ---
// Buat Toko Baru
app.post('/api/stores', async (req, res) => {
  const { user_id, nama_toko, alamat, no_telepon } = req.body;
  const { data, error } = await supabase
    .from('stores')
    .insert([{ user_id, nama_toko, alamat, no_telepon }])
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Get Toko berdasarkan User
app.get('/api/stores/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const { data, error } = await supabase
    .from('stores')
    .select('*')
    .eq('user_id', userId);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Hapus Toko beserta seluruh produk & transaksinya
app.delete('/api/stores/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('stores').delete().eq('id', id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Toko berhasil dihapus' });
});

// --- 3. MANAGEMENT PRODUCTS ---
// Tambah Produk Baru
app.post('/api/products', async (req, res) => {
  const { store_id, nama_produk, kategori, harga, stok } = req.body;
  const { data, error } = await supabase
    .from('products')
    .insert([{ store_id, nama_produk, kategori, harga, stok }])
    .select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Ambil Semua Produk berdasarkan Toko Aktif
app.get('/api/products/store/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('store_id', storeId);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Edit Produk
app.put('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { nama_produk, kategori, harga, stok } = req.body;
  const { data, error } = await supabase
    .from('products')
    .update({ nama_produk, kategori, harga, stok })
    .eq('id', id)
    .select();

  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

// Hapus Produk
app.delete('/api/products/:id', async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from('products').delete().eq('id', id);

  if (error) return res.status(400).json({ error: error.message });
  res.json({ message: 'Produk berhasil dihapus' });
});

// --- 4. TRANSAKSI KASIR (POS) & LAPORAN ---

// Simpan Transaksi Baru
app.post('/api/transactions', async (req, res) => {
  const { store_id, total_harga, bayar, kembalian, metode_pembayaran, items } = req.body;

  // 1. Simpan Header Transaksi (Menyimpan metode_pembayaran)
  const { data: trans, error: transErr } = await supabase
    .from('transactions')
    .insert([
      {
        store_id,
        total_harga,
        bayar,
        kembalian,
        metode_pembayaran: metode_pembayaran || 'Tunai',
      },
    ])
    .select()
    .single();

  if (transErr) return res.status(400).json({ error: transErr.message });

  // 2. Simpan Detail Transaksi & Update Stok
  const details = items.map((item) => ({
    transaction_id: trans.id,
    product_id: item.product_id,
    jumlah: item.jumlah,
    harga_satuan: item.harga_satuan,
    subtotal: item.subtotal,
  }));

  const { error: detailErr } = await supabase.from('transaction_details').insert(details);
  if (detailErr) return res.status(400).json({ error: detailErr.message });

  // Update stok produk
  for (const item of items) {
    const { data: prod } = await supabase.from('products').select('stok').eq('id', item.product_id).single();
    if (prod) {
      await supabase
        .from('products')
        .update({ stok: Math.max(0, prod.stok - item.jumlah) })
        .eq('id', item.product_id);
    }
  }

  res.json({
    message: 'Transaksi berhasil disimpan',
    transaction: trans,
  });
});

// Ambil Riwayat & Ringkasan Transaksi berdasarkan Toko
app.get('/api/transactions/store/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { data, error } = await supabase
    .from('transactions')
    .select('*')
    .eq('store_id', storeId)
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ error: error.message });

  const totalOmzet = data.reduce((acc, curr) => acc + Number(curr.total_harga), 0);
  const totalTransaksi = data.length;

  res.json({
    summary: {
      totalOmzet,
      totalTransaksi,
    },
    transactions: data,
  });
});

// GET /api/transactions/:id/items (BARU: Ambil Rincian Barang untuk Modal Detail Transaksi)
app.get('/api/transactions/:id/items', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('transaction_details')
    .select(`
      id,
      product_id,
      jumlah,
      harga_satuan,
      subtotal,
      products ( nama_produk )
    `)
    .eq('transaction_id', id);

  if (error) return res.status(400).json({ error: error.message });

  const formattedItems = data.map((item) => ({
    id: item.id,
    product_id: item.product_id,
    nama_produk: item.products ? item.products.nama_produk : 'Produk',
    jumlah: item.jumlah,
    harga_satuan: item.harga_satuan,
    subtotal: item.subtotal,
  }));

  res.json(formattedItems);
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Hapus Riwayat Transaksi & Kembalikan Stok Barang (Restock)
app.delete('/api/transactions/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // 1. Ambil detail item barang untuk mengembalikan stok
    const { data: details, error: detailFetchErr } = await supabase
      .from('transaction_details')
      .select('product_id, jumlah')
      .eq('transaction_id', id);

    if (detailFetchErr) return res.status(400).json({ error: detailFetchErr.message });

    // 2. Kembalikan stok ke tabel products
    for (const item of details) {
      const { data: prod } = await supabase
        .from('products')
        .select('stok')
        .eq('id', item.product_id)
        .single();

      if (prod) {
        await supabase
          .from('products')
          .update({ stok: prod.stok + item.jumlah })
          .eq('id', item.product_id);
      }
    }

    // 3. Hapus detail transaksi terlebih dahulu
    const { error: detailDeleteErr } = await supabase
      .from('transaction_details')
      .delete()
      .eq('transaction_id', id);

    if (detailDeleteErr) return res.status(400).json({ error: detailDeleteErr.message });

    // 4. Hapus header transaksi
    const { error: txDeleteErr } = await supabase
      .from('transactions')
      .delete()
      .eq('id', id);

    if (txDeleteErr) return res.status(400).json({ error: txDeleteErr.message });

    res.json({ message: 'Transaksi berhasil dihapus & stok telah dikembalikan' });
  } catch (error) {
    console.error('Error deleting transaction:', error);
    res.status(500).json({ error: error.message || 'Gagal menghapus transaksi' });
  }
});