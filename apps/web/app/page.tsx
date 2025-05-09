'use client';
import React from 'react';
import { motion } from 'framer-motion';
import { Rocket, Terminal, Code2, Zap, LayoutDashboard } from 'lucide-react'; // Example icons
import { useRouter } from 'next/navigation'; // Import useRouter

const HomePage = () => { //Renamed to Homepage
  const router = useRouter(); // Initialize router

  const handleRedirect = () => {
    router.push('/projects'); // Navigate to /projects
  };
   
  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 via-purple-900 to-black text-white flex flex-col">
      {/* Hero Section */}
      <header className="flex flex-col items-center justify-center text-center py-12 px-6 md:px-12 lg:px-24">
        <motion.div
          initial={{ opacity: 0, y: -20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          className="space-y-4 md:space-y-6"
        >
          <h1
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-purple-400"
          >
            CodeYarn
          </h1>
          <motion.p
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: 'easeInOut', delay: 0.3 }}
            className="text-lg sm:text-xl lg:text-2xl text-gray-300 max-w-3xl mx-auto" // Center text
          >
            Your All-in-One Cloud Development Environment. Code, build, and deploy
            faster.
          </motion.p>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.8, ease: 'easeInOut', delay: 0.6 }}
            className="flex justify-center" // Center the button
          >
            <button
              onClick={handleRedirect}
              className="bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white font-bold py-3 px-8 rounded-lg shadow-lg whitespace-nowrap transition-all duration-300"
            >
              <Rocket className="mr-2 h-5 w-5 inline-block" />
              Create Your Project Now
            </button>
          </motion.div>
        </motion.div>
      </header>

      {/* Features Section */}
      <section className="py-16 px-6 md:px-12 lg:px-24">
        <h2 className="text-3xl md:text-4xl font-semibold text-center mb-12 bg-clip-text text-transparent bg-gradient-to-r from-blue-300 to-purple-300">
          Key Features
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-10">
          <motion.div
            whileHover={{ scale: 1.05 }}
            transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            className="bg-white/5 backdrop-blur-md rounded-xl p-6 border border-gray-800 shadow-lg hover:shadow-blue-500/20"
          >
            <Terminal className="h-8 w-8 text-blue-400 mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">Instant Environments</h3>
            <p className="text-gray-300">
              Spin up development environments in seconds. No more waiting for
              long setups.
            </p>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05 }}
            transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            className="bg-white/5 backdrop-blur-md rounded-xl p-6 border border-gray-800 shadow-lg hover:shadow-blue-500/20"
          >
            <Zap className="h-8 w-8 text-green-400 mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">
              Powerful Performance
            </h3>
            <p className="text-gray-300">
              Experience fast and responsive coding with our optimized cloud
              infrastructure.
            </p>
          </motion.div>
          <motion.div
            whileHover={{ scale: 1.05 }}
            transition={{ type: 'spring', stiffness: 400, damping: 17 }}
            className="bg-white/5 backdrop-blur-md rounded-xl p-6 border border-gray-800 shadow-lg hover:shadow-blue-500/20"
          >
            <LayoutDashboard className="h-8 w-8 text-pink-400 mb-4" />
            <h3 className="text-xl font-semibold text-white mb-2">
              Full Stack Support
            </h3>
            <p className="text-gray-300">
              Develop any kind of application.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Call to Action Section */}
      <section className="py-16 px-6 md:px-12 lg:px-24 text-center">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          className="bg-white/5 backdrop-blur-md rounded-xl p-10 border border-gray-800 shadow-2xl"
        >
          <h2 className="text-3xl md:text-4xl font-bold text-white mb-6">
            Start Coding Now!
          </h2>
          <p className="text-lg text-gray-300 mb-8 max-w-2xl mx-auto">
            Create your project and start building amazing things with CodeYarn.
          </p>
          <button
            onClick={handleRedirect}
            className="bg-gradient-to-r from-blue-500 to-purple-500 hover:from-blue-600 hover:to-purple-600 text-white font-bold py-3 px-8 rounded-lg shadow-lg whitespace-nowrap transition-all duration-300"
          >
            Create Your Project Now
          </button>
        </motion.div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 md:px-12 lg:px-24 text-center text-gray-400 border-t border-gray-800">
        <p>&copy; {new Date().getFullYear()} CodeYarn. All rights reserved.</p>
        {/* Add links to privacy policy, terms of service, etc. if needed */}
      </footer>
    </div>
  );
};

export default HomePage;
