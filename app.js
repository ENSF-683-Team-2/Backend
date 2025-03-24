// backend/app.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');

const { runCode } = require('./services/codeExecution');

// Initialize express app
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize SQLite database
const db = new sqlite3.Database('./code_platform.db', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database');
    // Create tables if they don't exist
    db.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        problem_id INTEGER,
        code TEXT NOT NULL,
        status TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);
    
    db.run(`
      CREATE TABLE IF NOT EXISTS problems (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        example_input TEXT,
        example_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        level TEXT CHECK(level IN ('low', 'medium', 'high')), starter_code TEXT, fn_name TEXT
      )
    `);
  }
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Access denied' });
  
  jwt.verify(token, 'your_jwt_secret', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Routes


app.post('/api/analyze', authenticateToken, async (req, res) => {
  const { code, problem_id } = req.body;
  const { id: user_id } = req.user;

  if (!code || !problem_id) {
    return res.status(400).json({ error: 'Code and problem_id are required' });
  }

  db.get(
    'SELECT title, description, example_input, example_output FROM problems WHERE id = ?',
    [problem_id],
    async (err, problem) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (!problem) {
        console.warn(`Problem with ID ${problem_id} not found`);
        return res.status(404).json({ error: 'Problem not found' });
      }

      const prompt = `
        You are a senior software engineer. Provide short, specific feedback on this code in relation to the problem’s solution. If the code doesn’t solve it, give a brief hint to reach the solution. If it works, suggest one or two concise improvements. Limit your response to 1-2 sentences:
        Problem: ${problem.title}
        Description: ${problem.description}
        Example Input: ${problem.example_input}
        Example Output: ${problem.example_output}
        Code: \`\`\`python
        ${code}
        \`\`\`
      `;

      try {
        // Set response headers for streaming
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Transfer-Encoding', 'chunked');

        const ollamaResponse = await axios.post(
          'http://localhost:11434/api/generate',
          {
            model: 'gemma3',
            prompt: prompt,
            stream: true, // Enable streaming
          },
          { responseType: 'stream' } // Handle as a stream
        );

        // Pipe Ollama's stream to the response
        ollamaResponse.data.pipe(res);

        // Save to database after streaming is complete
        ollamaResponse.data.on('end', () => {
          db.run(
            'INSERT INTO submissions (user_id, problem_id, code, status) VALUES (?, ?, ?, ?)',
            [user_id, problem_id, code, 'analyzed'],
            function (err) {
              if (err) {
                console.error('Database insertion error:', err);
              }
            }
          );
        });
      } catch (error) {
        console.error('Error communicating with Ollama:', error.message);
        res.status(500).json({ error: 'Failed to analyze code: ' + error.message });
      }
    }
  );
});

// Register user
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            return res.status(409).json({ error: 'Username already exists' });
          }
          return res.status(500).json({ error: err.message });
        }
        
        const token = jwt.sign({ id: this.lastID, username }, 'your_jwt_secret', { expiresIn: '1h' });
        res.status(201).json({ token });
      }
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login user
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  
  db.get(
    'SELECT * FROM users WHERE username = ?',
    [username],
    async (err, user) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      
      const validPassword = await bcrypt.compare(password, user.password);
      if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });
      
      const token = jwt.sign({ id: user.id, username }, 'your_jwt_secret', { expiresIn: '1h' });
      res.json({ token });
    }
  );
});

// Submit code
app.post('/api/submissions', authenticateToken, (req, res) => {
  const { problem_id, code } = req.body;
  const { id: user_id } = req.user;
  
  if (!code) {
    return res.status(400).json({ error: 'Code is required' });
  }
  
  db.run(
    'INSERT INTO submissions (user_id, problem_id, code, status) VALUES (?, ?, ?, ?)',
    [user_id, problem_id || null, code, 'submitted'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      
      res.status(201).json({
        id: this.lastID,
        user_id,
        problem_id,
        code,
        status: 'submitted',
        created_at: new Date().toISOString()
      });
    }
  );
});

// Get user submissions
app.get('/api/submissions', authenticateToken, (req, res) => {
  const { id: user_id } = req.user;
  
  db.all(
    'SELECT * FROM submissions WHERE user_id = ? ORDER BY created_at DESC',
    [user_id],
    (err, submissions) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ submissions });
    }
  );
});

// Fetch a problem by ID
app.get('/api/problems/:id', (req, res) => {
  const { id } = req.params; // Extract `id` from the URL
  console.log(`Fetching problem with ID: ${id}`); // Debug log

  db.get(
    'SELECT * FROM problems WHERE id = ?', // Use `id` in the SQL query
    [id], // Pass `id` as a parameter to the query
    (err, problem) => {
      if (err) {
        console.error('Database error:', err); // Debug log
        return res.status(500).json({ error: 'Database error' });
      }
      if (!problem) {
        console.warn(`Problem with ID ${id} not found`); // Debug log
        return res.status(404).json({ error: 'Problem not found' });
      }
      console.log(`Problem fetched:`, problem); // Debug log
      res.json(problem);
    }
  );
});

// Run code with actual Python execution
app.post('/api/run', authenticateToken, async (req, res) => {
  console.log('Run API endpoint called');
  const { code, problem_id } = req.body;
  const { id: user_id } = req.user;

  if (!code || !problem_id) {
    if(!code){
      return res.status(400).json({ error: 'Its the code' });
    }
    return res.status(400).json({ error: 'Code and problem_id are required' });
  }

  console.log(`User code received for problem ID ${problem_id}:`, code.substring(0, 100) + '...');

  // Fetch problem details from the database
  db.get(
    'SELECT fn_name, example_input, example_output FROM problems WHERE id = ?',
    [problem_id],
    async (err, problem) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      if (!problem) {
        console.warn(`Problem with ID ${problem_id} not found`);
        return res.status(404).json({ error: 'Problem not found' });
      }

      console.log(`Fetched problem details:`, problem);

      try {
        // Sanitize the function name
        // const functionName = problem.fn_name.replace(/\s+/g, '_').toLowerCase();
        const functionName = problem.fn_name;

        console.log('Function name:', functionName);
        const exampleInput = problem.example_input.replace('Input: ', '').trim();
        const exampleOutput = problem.example_output.trim();

        // Execute the code
        console.log('Calling runCode function');
        const results = await runCode(code, functionName, exampleInput, exampleOutput);
        console.log('Execution results:', JSON.stringify(results).substring(0, 100) + '...');

        // Store the submission (even if it failed)
        db.run(
          'INSERT INTO submissions (user_id, problem_id, code, status) VALUES (?, ?, ?, ?)',
          [user_id, problem_id, code, results.success ? 'passed' : 'failed'],
          function (err) {
            if (err) {
              console.error('Database error:', err);
              return res.status(500).json({ error: err.message });
            }

            console.log('Submission stored, ID:', this.lastID);
            res.json({
              submission_id: this.lastID,
              ...results,
            });
          }
        );
      } catch (error) {
        console.error('Error in /api/run:', error);
        res.status(500).json({
          success: false,
          error: 'An error occurred while processing your code: ' + error.message,
        });
      }
    }
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

module.exports = app;