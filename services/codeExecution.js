// backend/services/codeExecution.js
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

// Use the system's temp directory
const TEMP_DIR = os.tmpdir();
console.log('Using system temp directory:', TEMP_DIR);

/**
 * Checks if the submitted code contains an implementation
 * or just comments/placeholders
 */
const validateCode = (code) => {
  // Split the code into lines
  const lines = code.split('\n');
  
  // Check if there's a function definition
  const functionLineIndex = lines.findIndex(line => line.trim().startsWith('def two_sum'));
  
  if (functionLineIndex === -1) {
    return {
      valid: false,
      error: 'No two_sum function found. Please define a function named two_sum(nums, target).'
    };
  }
  
  // Check if there's at least one non-comment, non-empty line after the function definition
  let hasImplementation = false;
  for (let i = functionLineIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check if this line is indented (part of the function)
    if (lines[i].startsWith(' ') || lines[i].startsWith('\t')) {
      // Check if it's not just a comment or empty
      if (line !== '' && !line.startsWith('#')) {
        hasImplementation = true;
        break;
      }
    } else if (line !== '') {
      // If we hit a non-indented, non-empty line, we've exited the function
      break;
    }
  }
  
  if (!hasImplementation) {
    // If no implementation, let's add a pass statement to make it valid Python
    lines.splice(functionLineIndex + 1, 0, '    pass  # Added automatically');
    return {
      valid: true,
      modifiedCode: lines.join('\n'),
      message: 'Your function appears to be empty. A pass statement has been added to make it valid.'
    };
  }
  
  return {
    valid: true,
    modifiedCode: code
  };
};

/**
 * Prepares a test file with the user's code and test cases
 */
const prepareTestFile = (code) => {
  const uuid = uuidv4();
  const filePath = path.join(TEMP_DIR, `${uuid}.py`);
  console.log('Creating test file at:', filePath);
  
  // Validate and potentially modify the code
  const validation = validateCode(code);
  
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  
  // Use the potentially modified code
  const validatedCode = validation.modifiedCode;
  
  // Test cases for the two_sum problem
  const testCases = [
    { input: '[2, 7, 11, 15], 9', output: '[0, 1]' },
    { input: '[3, 2, 4], 6', output: '[1, 2]' },
    { input: '[3, 3], 6', output: '[0, 1]' }
  ];
  
  // Directly include user code at the beginning, then our test harness
  const testCode = `${validatedCode}

import json
import time

def run_tests():
    results = []
    
    try:
        # Test case 1
        start_time = time.time()
        nums = [2, 7, 11, 15]
        target = 9
        expected = "[0, 1]"
        
        actual = two_sum(nums, target)
        execution_time = time.time() - start_time
        
        results.append({
            "case": 1,
            "input": "[2, 7, 11, 15], 9",
            "expected": "[0, 1]",
            "actual": str(actual),
            "passed": str(actual) == "[0, 1]",
            "execution_time": execution_time
        })
        
        # Test case 2
        start_time = time.time()
        nums = [3, 2, 4]
        target = 6
        expected = "[1, 2]"
        
        actual = two_sum(nums, target)
        execution_time = time.time() - start_time
        
        results.append({
            "case": 2,
            "input": "[3, 2, 4], 6",
            "expected": "[1, 2]",
            "actual": str(actual),
            "passed": str(actual) == "[1, 2]",
            "execution_time": execution_time
        })
        
        # Test case 3
        start_time = time.time()
        nums = [3, 3]
        target = 6
        expected = "[0, 1]"
        
        actual = two_sum(nums, target)
        execution_time = time.time() - start_time
        
        results.append({
            "case": 3,
            "input": "[3, 3], 6",
            "expected": "[0, 1]",
            "actual": str(actual),
            "passed": str(actual) == "[0, 1]",
            "execution_time": execution_time
        })
    except Exception as e:
        results.append({
            "error": str(e)
        })
    
    return results

# Run tests and print JSON results
print(json.dumps(run_tests()))
`;

  // Write to file
  try {
    fs.writeFileSync(filePath, testCode);
    console.log('Successfully wrote test file');
    return { filePath, message: validation.message };
  } catch (error) {
    console.error('Error writing test file:', error);
    throw error;
  }
};

/**
 * Executes Python code and returns the results
 */
const executeCode = (filePath, message = null) => {
  console.log('Executing Python file:', filePath);
  
  return new Promise((resolve, reject) => {
    exec(`python "${filePath}"`, (error, stdout, stderr) => {
      console.log('Python execution complete');
      
      // Log results for debugging
      if (error) console.error('Execution error:', error);
      if (stderr) console.error('STDERR:', stderr);
      if (stdout) console.log('STDOUT first 100 chars:', stdout.substring(0, 100));
      
      try {
        // Clean up the file
        fs.unlinkSync(filePath);
        console.log('Cleaned up test file');
        
        if (error) {
          return resolve({
            success: false,
            error: stderr || error.message
          });
        }
        
        try {
          const results = JSON.parse(stdout);
          
          // Check if there was an error during execution
          if (results.length === 1 && results[0].error) {
            return resolve({
              success: false,
              error: results[0].error
            });
          }
          
          const allPassed = results.every(result => result.passed === "True" || result.passed === true);
          const totalTime = results.reduce((acc, curr) => acc + (curr.execution_time || 0), 0).toFixed(4);
          
          const response = {
            success: allPassed,
            output: allPassed ? "All test cases passed!" : "Some test cases failed.",
            testResults: results,
            executionTime: `${totalTime}s`
          };
          
          // Add message if exists
          if (message) {
            response.message = message;
          }
          
          return resolve(response);
        } catch (parseError) {
          console.error('Error parsing Python output:', parseError);
          return resolve({
            success: false,
            error: `Failed to parse Python output: ${parseError.message}\nRaw output: ${stdout}`
          });
        }
      } catch (err) {
        console.error('Error during cleanup or results processing:', err);
        resolve({
          success: false,
          error: `Failed to process execution results: ${err.message}`
        });
      }
    });
  });
};

/**
 * Runs the user's code against test cases
 */
const runCode = async (code) => {
  console.log('Running code execution process');
  try {
    // Prepare the test file
    const { filePath, message } = prepareTestFile(code);
    
    // Execute the code
    return await executeCode(filePath, message);
  } catch (error) {
    console.error('Error in running code:', error);
    return {
      success: false,
      error: `Failed to execute code: ${error.message}`
    };
  }
};

module.exports = {
  runCode
};