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
 * Checks if the submitted code contains the required function
 */
const validateCode = (code, functionName) => {
  // Split the code into lines
  const lines = code.split('\n');
  
  // Check if there's a function definition for the required function
  const functionLineIndex = lines.findIndex(line => line.trim().startsWith(`def ${functionName}(`));
  
  if (functionLineIndex === -1) {
    return {
      valid: false,
      error: `The function "${functionName}" is not defined. Please define it as: def ${functionName}(...)`
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
const prepareTestFile = (code, functionName, exampleInput, exampleOutput) => {
  const uuid = uuidv4();
  const filePath = path.join(TEMP_DIR, `${uuid}.py`);
  console.log('Creating test file at:', filePath);
  
  // Validate and potentially modify the code
  const validation = validateCode(code, functionName);
  
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  
  // Use the potentially modified code
  const validatedCode = validation.modifiedCode;
  
  // Check if the function is inside a class
  const isClassBased = /class\s+\w+\s*\(/.test(code);

  // Strip variable names from exampleInput (e.g., "nums=[1,2,3,1]" -> "[1,2,3,1]")
  const strippedInput = exampleInput.replace(/^\w+=/, '').trim();

  // Format exampleInput to ensure it is valid Python syntax
  const formattedInput = strippedInput.startsWith('[') || strippedInput.startsWith('{') || strippedInput.startsWith('(')
    ? strippedInput // Input is already a list, dict, or tuple
    : `${strippedInput}`; // Wrap in a list if it's a single value

  // Generate the test harness
  const testCode = `${validatedCode}

import json
import time

def run_tests():
    results = []
    
    try:
        # Test case
        start_time = time.time()
        input_data = ${formattedInput}  # Ensure valid Python syntax
        expected = ${JSON.stringify(exampleOutput)}  # Ensure valid Python syntax
        
        ${isClassBased ? `
        # Instantiate the class and call the method
        solution = Solution()
        actual = solution.${functionName}(input_data)
        ` : `
        # Call the function directly
        actual = ${functionName}(input_data)
        `}
        
        execution_time = time.time() - start_time
        
        results.append({
            "input": str(input_data),
            "expected": str(expected),
            "actual": str(actual),
            "passed": str(actual).lower() == str(expected).lower(),
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
    exec(`python3 "${filePath}"`, (error, stdout, stderr) => {
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
const runCode = async (code, functionName, exampleInput, exampleOutput) => {
  console.log('Running code execution process');
  try {
    // Prepare the test file
    const { filePath, message } = prepareTestFile(code, functionName, exampleInput, exampleOutput);
    
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