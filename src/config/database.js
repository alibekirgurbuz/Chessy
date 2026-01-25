const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    if (!process.env.MONGODB_URI) {
      throw new Error('MONGODB_URI is not defined in environment variables. Please create a .env file with MONGODB_URI.');
    }

    const conn = await mongoose.connect(process.env.MONGODB_URI);

    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('Database connection error:', error.message);
    
    // IP whitelist hatası için daha açıklayıcı mesaj
    if (error.message.includes('whitelist') || error.message.includes('IP')) {
      console.error('\n⚠️  IP Whitelist Hatası!');
      console.error('MongoDB Atlas\'ta IP adresinizi whitelist\'e eklemeniz gerekiyor.');
      console.error('1. MongoDB Atlas Dashboard → Network Access');
      console.error('2. "Add IP Address" butonuna tıklayın');
      console.error('3. IP adresinizi ekleyin veya "Allow Access from Anywhere" seçeneğini kullanın');
      console.error('4. Birkaç dakika bekleyin ve sunucuyu yeniden başlatın\n');
    }
    
    process.exit(1);
  }
};

module.exports = connectDB;
