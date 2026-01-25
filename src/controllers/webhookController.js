const User = require('../models/User');

const handleUserCreated = async (payload) => {
  try {
    const { id, email_addresses, first_name, last_name, image_url } = payload.data || {};

    // Email kontrolü - Clerk'te email_addresses array olabilir veya primary_email_address olabilir
    let email = null;

    // Önce email_addresses array'inden dene
    if (email_addresses && Array.isArray(email_addresses) && email_addresses.length > 0) {
      // email_addresses array'inin içindeki her bir eleman bir object olabilir
      for (const emailObj of email_addresses) {
        if (typeof emailObj === 'object' && emailObj.email_address) {
          email = emailObj.email_address;
          break;
        } else if (typeof emailObj === 'string') {
          email = emailObj;
          break;
        }
      }
    }

    // Eğer hala yoksa, primary_email_address_id ile eşleştir
    if (!email && payload.data?.primary_email_address_id && email_addresses && email_addresses.length > 0) {
      const primaryEmailObj = email_addresses.find(
        (e) => e.id === payload.data.primary_email_address_id ||
          (typeof e === 'object' && e.id === payload.data.primary_email_address_id)
      );
      if (primaryEmailObj) {
        email = typeof primaryEmailObj === 'object' ? primaryEmailObj.email_address : primaryEmailObj;
      }
    }

    // Eğer hala yoksa, primary_email_address direkt dene
    if (!email && payload.data?.primary_email_address) {
      email = payload.data.primary_email_address;
    }

    // Test webhook'larında email olmayabilir - placeholder email oluştur
    if (!email) {
      console.warn('Email not found in payload. Creating placeholder email for test user.');
      email = `${id}@test.clerk.dev`; // Test için placeholder email
    }

    console.log('Creating user with data:', {
      clerkId: id,
      email,
      firstName: first_name,
      lastName: last_name,
    });

    const user = await User.create({
      clerkId: id,
      email: email,
      firstName: first_name || '',
      lastName: last_name || '',
      imageUrl: image_url || '',
    });

    console.log('User created successfully:', user._id);
    return { success: true, user };
  } catch (error) {
    // Duplicate key error - kullanıcı zaten mevcut
    if (error.code === 11000) {
      console.log('User already exists with clerkId:', payload.data?.id);
      const existingUser = await User.findOne({ clerkId: payload.data?.id });
      if (existingUser) {
        console.log('Returning existing user:', existingUser._id);
        return { success: true, user: existingUser, alreadyExists: true };
      }
    }
    
    console.error('Error creating user:', error);
    console.error('Error details:', {
      message: error.message,
      name: error.name,
      code: error.code,
      keyPattern: error.keyPattern,
      keyValue: error.keyValue,
    });
    throw error;
  }
};

const handleUserUpdated = async (payload) => {
  try {
    const { id, email_addresses, first_name, last_name, image_url } = payload.data;

    const user = await User.findOneAndUpdate(
      { clerkId: id },
      {
        email: email_addresses[0]?.email_address || '',
        firstName: first_name || '',
        lastName: last_name || '',
        imageUrl: image_url || '',
      },
      { new: true, runValidators: true }
    );

    if (!user) {
      throw new Error('User not found');
    }

    console.log('User updated:', user._id);
    return { success: true, user };
  } catch (error) {
    console.error('Error updating user:', error);
    throw error;
  }
};

const handleUserDeleted = async (payload) => {
  try {
    const { id } = payload.data;

    const user = await User.findOneAndDelete({ clerkId: id });

    if (!user) {
      throw new Error('User not found');
    }

    console.log('User deleted:', user._id);
    return { success: true, user };
  } catch (error) {
    console.error('Error deleting user:', error);
    throw error;
  }
};

module.exports = {
  handleUserCreated,
  handleUserUpdated,
  handleUserDeleted,
};
