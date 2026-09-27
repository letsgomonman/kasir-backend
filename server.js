import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import ExcelJS from 'exceljs';
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

// --- 4. TRANSAKSI KASIR (POS), DISKON & KASBON ---

// Simpan Transaksi Baru (Mendukung Diskon, Kasbon/Nama Pelanggan, & Status)
app.post('/api/transactions', async (req, res) => {
  const {
    store_id,
    total_harga,
    diskon = 0,
    bayar,
    kembalian,
    metode_pembayaran,
    nama_pelanggan,
    status_pembayaran = 'Lunas',
    items,
  } = req.body;

  try {
    // 1. Simpan Header Transaksi
    const { data: trans, error: transErr } = await supabase
      .from('transactions')
      .insert([
        {
          store_id,
          total_harga,
          diskon,
          bayar,
          kembalian,
          metode_pembayaran: metode_pembayaran || 'Tunai',
          nama_pelanggan: nama_pelanggan || null,
          status_pembayaran: status_pembayaran || 'Lunas',
        },
      ])
      .select()
      .single();

    if (transErr) return res.status(400).json({ error: transErr.message });

    // 2. Simpan Catatan Piutang jika status "Belum Lunas"
    if (status_pembayaran === 'Belum Lunas' && nama_pelanggan) {
      const sisaHutang = Math.max(0, total_harga - bayar);
      const { error: debtErr } = await supabase.from('debts').insert([
        {
          store_id,
          transaction_id: trans.id,
          nama_pelanggan,
          sisa_hutang: sisaHutang,
        },
      ]);
      if (debtErr) console.error('Gagal mencatat kasbon:', debtErr.message);
    }

    // 3. Simpan Detail Transaksi & Update Stok
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
  } catch (error) {
    console.error('Error create transaction:', error);
    res.status(500).json({ error: error.message || 'Gagal memproses transaksi' });
  }
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

// Ambil Rincian Barang untuk Modal Detail Transaksi
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

    // 4. Hapus header transaksi (cascade ke debts jika dikonfigurasi)
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

// --- 5. EXPORT LAPORAN EXCEL (.xlsx) ---
app.get('/api/transactions/export/excel/:storeId', async (req, res) => {
  const { storeId } = req.params;

  try {
    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('store_id', storeId)
      .order('created_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Laporan Penjualan');

    worksheet.columns = [
      { header: 'ID Transaksi', key: 'id', width: 25 },
      { header: 'Tanggal', key: 'created_at', width: 20 },
      { header: 'Pelanggan', key: 'nama_pelanggan', width: 20 },
      { header: 'Metode', key: 'metode_pembayaran', width: 15 },
      { header: 'Status', key: 'status_pembayaran', width: 15 },
      { header: 'Diskon (Rp)', key: 'diskon', width: 15 },
      { header: 'Total (Rp)', key: 'total_harga', width: 18 },
      { header: 'Bayar (Rp)', key: 'bayar', width: 18 },
      { header: 'Kembalian (Rp)', key: 'kembalian', width: 18 },
    ];

    transactions.forEach((tx) => {
      worksheet.addRow({
        id: tx.id,
        created_at: new Date(tx.created_at).toLocaleString('id-ID'),
        nama_pelanggan: tx.nama_pelanggan || 'Umum',
        metode_pembayaran: tx.metode_pembayaran || 'Tunai',
        status_pembayaran: tx.status_pembayaran || 'Lunas',
        diskon: Number(tx.diskon || 0),
        total_harga: Number(tx.total_harga || 0),
        bayar: Number(tx.bayar || 0),
        kembalian: Number(tx.kembalian || 0),
      });
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename=' + `Laporan_Penjualan_${storeId}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error export excel:', err);
    res.status(500).json({ error: err.message || 'Gagal mengekspor laporan Excel' });
  }
});

// --- 6. MANAGEMENT KASBON / PIUTANG PELANGGAN ---

// Ambil daftar piutang toko yang belum lunas
app.get('/api/debts/store/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { data, error } = await supabase
    .from('debts')
    .select('*')
    .eq('store_id', storeId)
    .gt('sisa_hutang', 0);

  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Pelunasan / Cicilan Kasbon
app.post('/api/debts/:id/pay', async (req, res) => {
  const { id } = req.params;
  const { jumlah_bayar } = req.body;

  const { data: debt, error: fetchErr } = await supabase.from('debts').select('*').eq('id', id).single();
  if (fetchErr || !debt) return res.status(404).json({ error: 'Data kasbon tidak ditemukan' });

  const sisaBaru = Math.max(0, debt.sisa_hutang - jumlah_bayar);
  const { error: updateErr } = await supabase.from('debts').update({ sisa_hutang: sisaBaru }).eq('id', id);

  if (updateErr) return res.status(400).json({ error: updateErr.message });

  if (sisaBaru === 0 && debt.transaction_id) {
    await supabase.from('transactions').update({ status_pembayaran: 'Lunas' }).eq('id', debt.transaction_id);
  }

  res.json({ message: 'Pembayaran kasbon berhasil dicatat', sisa_hutang: sisaBaru });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- 7. ANALITIK GRAFIK OMZET & PRODUK TERLARIS ---

// Endpoint untuk Grafik Omzet (7 Hari Terakhir & 30 Hari Terakhir)
app.get('/api/analytics/sales-trend/:storeId', async (req, res) => {
  const { storeId } = req.params;
  const { range = '7days' } = req.query; // '7days' atau '30days'

  try {
    const days = range === '30days' ? 30 : 7;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - (days - 1));
    startDate.setHours(0, 0, 0, 0);

    const { data: transactions, error } = await supabase
      .from('transactions')
      .select('total_harga, created_at')
      .eq('store_id', storeId)
      .gte('created_at', startDate.toISOString());

    if (error) return res.status(400).json({ error: error.message });

    // Grouping berdasarkan tanggal (YYYY-MM-DD)
    const trendMap = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(startDate);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().split('T')[0];
      trendMap[dateStr] = 0;
    }

    transactions.forEach((tx) => {
      const dateStr = new Date(tx.created_at).toISOString().split('T')[0];
      if (trendMap[dateStr] !== undefined) {
        trendMap[dateStr] += Number(tx.total_harga || 0);
      }
    });

    const trendData = Object.keys(trendMap).map((date) => ({
      date,
      formattedDate: new Date(date).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
      }),
      omzet: trendMap[date],
    }));

    res.json(trendData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint untuk Produk Terlaris (Top Selling)
app.get('/api/analytics/top-products/:storeId', async (req, res) => {
  const { storeId } = req.params;

  try {
    // 1. Ambil transaksi toko
    const { data: txs, error: txErr } = await supabase
      .from('transactions')
      .select('id')
      .eq('store_id', storeId);

    if (txErr) return res.status(400).json({ error: txErr.message });
    if (!txs || txs.length === 0) return res.json([]);

    const txIds = txs.map((t) => t.id);

    // 2. Ambil detail transaksi
    const { data: details, error: detailErr } = await supabase
      .from('transaction_details')
      .select(`
        product_id,
        jumlah,
        subtotal,
        products ( nama_produk, kategori )
      `)
      .in('transaction_id', txIds);

    if (detailErr) return res.status(400).json({ error: detailErr.message });

    // 3. Agregasi total terjual per produk
    const productMap = {};
    details.forEach((item) => {
      const pid = item.product_id;
      const nama = item.products ? item.products.nama_produk : 'Produk Dihapus';
      const kategori = item.products ? item.products.kategori : 'Umum';

      if (!productMap[pid]) {
        productMap[pid] = {
          product_id: pid,
          nama_produk: nama,
          kategori: kategori,
          total_terjual: 0,
          total_pendapatan: 0,
        };
      }

      productMap[pid].total_terjual += Number(item.jumlah || 0);
      productMap[pid].total_pendapatan += Number(item.subtotal || 0);
    });

    // Sort berdasarkan jumlah terbanyak & ambil Top 5
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.total_terjual - a.total_terjual)
      .slice(0, 5);

    res.json(topProducts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});