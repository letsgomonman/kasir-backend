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

// --- 4. TRANSAKSI KASIR (POS) ---
app.post('/api/transactions', async (req, res) => {
  const { store_id, total_harga, bayar, kembalian, items } = req.body;

  // 1. Simpan Header Transaksi
  const { data: trans, error: transErr } = await supabase
    .from('transactions')
    .insert([{ store_id, total_harga, bayar, kembalian }])
    .select()
    .single();

  if (transErr) return res.status(400).json({ error: transErr.message });

  // 2. Simpan Detail Transaksi & Update Stok
  const details = items.map(item => ({
    transaction_id: trans.id,
    product_id: item.product_id,
    jumlah: item.jumlah,
    harga_satuan: item.harga_satuan,
    subtotal: item.subtotal
  }));

  const { error: detailErr } = await supabase.from('transaction_details').insert(details);
  if (detailErr) return res.status(400).json({ error: detailErr.message });

  // Update stok produk
  for (const item of items) {
    const { data: prod } = await supabase.from('products').select('stok').eq('id', item.product_id).single();
    if (prod) {
      await supabase.from('products').update({ stok: prod.stok - item.jumlah }).eq('id', item.product_id);
    }
  }

  res.json({ message: 'Transaksi berhasil disimpan', transaction_id: trans.id });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));