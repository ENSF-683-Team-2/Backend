# Backend

## Setup with npm install
Ignore the warnings

## Include the `.env` file
Content found in the discord

## Run with
`node app.js`

## Ollama installation and run instructions
Download ollama: https://ollama.com/download
Open powershell or terminal and run `ollama pull gemma3`
Once you have the gemma3 model, run the follwing command `ollama serve`

## Ollama serve error fix
If you get an error when running the serve command due to the socket/port already being used
End the process and re run the command
On windows this can be done by running `netstat -aon | findstr :11434`
Once the netstat is run, simply kill the task with this command `taskkill /PID <task> /F` (replace task with the id)

