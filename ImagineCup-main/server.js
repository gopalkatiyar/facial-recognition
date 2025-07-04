const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const app = express();
const bodyParser = require('body-parser');

// Directories for storing images
const uploadDir = 'known_faces';
const unknownUploadDir = 'unknown_faces';
const frameDir = 'frames'; // Directory for storing frames

// Ensure directories exist
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(unknownUploadDir, { recursive: true });
fs.mkdirSync(frameDir, { recursive: true }); // For frames

// Multer setup for handling file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const filename = req.body.imageName
        ? `${req.body.imageName}${path.extname(file.originalname)}`
        : `${file.originalname}`;
        cb(null, filename);
    }
});

const frameStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, frameDir);
    },
    filename: (req, file, cb) => {
        cb(null, 'frame-' + Date.now() + path.extname(file.originalname));
    }
});

const upload = multer({ storage: storage });
const frameUpload = multer({ storage: frameStorage });

// Middleware
app.use(express.json());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

// Routes for serving HTML pages
app.get('/pages/workFlow.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'workFlow.html'));
});

app.get('/pages/knownPersons.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'knownPersons.html'));
});

app.get('/pages/unknownPersons.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'unknownPersons.html'));
});

app.get('/pages/lastLocation.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'lastLocation.html'));
});

// Static file serving for images
app.use('/known_faces', express.static(path.join(__dirname, uploadDir)));
app.use('/unknown_faces', express.static(path.join(__dirname, unknownUploadDir)));

// Image upload route
app.post('/upload', upload.single('myImage'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    res.send(`File uploaded successfully! Access it at /known_faces/${req.file.filename}`);
});

// Route for getting list of images
app.get('/known-images', (req, res) => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) {
            res.status(500).send('Unable to scan directory');
        } else {
            res.json(files);
        }
    });
});



app.get('/unknown-images', (req, res) => {
    fs.readdir(unknownUploadDir, (err, files) => {
        if (err) {
            res.status(500).send('Unable to scan directory');
        } else {
            res.json(files);
        }
    });
});

// Serve an image from known_faces or unknown_faces based on the query
app.get('/get-image', (req, res) => {
    const { type, filename } = req.query;

    if (!type || !filename) {
        return res.status(400).send('Missing type or filename parameter');
    }

    let folderPath;
    if (type === 'known') {
        folderPath = path.join(__dirname, uploadDir);
    } else if (type === 'unknown') {
        folderPath = path.join(__dirname, unknownUploadDir);
    } else {
        return res.status(400).send('Invalid type parameter. Use "known" or "unknown".');
    }

    const filePath = path.join(folderPath, filename);

    // Check if the file exists before sending
    fs.access(filePath, fs.constants.F_OK, (err) => {
        if (err) {
            return res.status(404).send('File not found');
        }

        res.sendFile(filePath);
    });
});

app.get('/logs', (req, res) => { 
    const logFilePath = path.join(__dirname, 'log.txt');

    fs.readFile(logFilePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Failed to read log file:', err);
            return res.status(500).send('Failed to retrieve logs');
        }

        // Split logs into lines and filter empty lines
        const logs = data
            .split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
                const [dateTime, person] = line.split(' - ');
                const [date, time] = dateTime.split(' ');
                const personName = person.replace('Person: ', '');

                return {
                    date,
                    time,
                    person: personName
                };
            })
            .reverse();

        res.json(logs);
    });
});



// Move image from unknown to known directory
app.post('/move-image', (req, res) => {
    const { fileName, personName } = req.body;
    if (!fileName || !personName) { // Corrected the logical OR operator
        return res.status(400).send('Missing fileName or personName');
    }

    const oldPath = path.join(unknownUploadDir, fileName);
    const newPath = path.join(uploadDir, `${personName}${path.extname(fileName)}`);

    fs.rename(oldPath, newPath, (err) => {
        if (err) {
            return res.status(500).send('Error moving file');
        }
        res.send('File moved successfully');
    });
});

// Route to receive video frame data
app.post('/upload-frame', frameUpload.single('frame'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No frame uploaded.');
    }
    const framePath = path.join(__dirname, frameDir, req.file.filename);
    
    // Call cv.py for face recognition
    const faceRecognitionProcess = spawn('python', ['cv.py', framePath]);

    faceRecognitionProcess.stdout.on('data', (data) => {
        const output = data.toString().trim();
        const faceResult = output.split(','); 
        const personName = faceResult[1] || 'unknown'; 
        
        const objectRecognitionProcess = spawn('python', ['object.py', framePath]);

        objectRecognitionProcess.stdout.on('data', (objectData) => {
            const objectOutput = objectData.toString().trim();
            const objectResults = objectOutput.split(',');
            const imagePath = objectResults.shift();
            const detectedObjects = objectResults;

            // Combine results from face and object recognition
            const result = {
                faceRecognition: { imagePath: faceResult[0], personName },
                objectRecognition: { imagePath, detectedObjects }
            };

            // Save only the time and person information to the log file
            const now = new Date();
            const formattedDate = now.toLocaleString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
            }).replace(',', ''); // Remove comma between date and time
            
            const logEntry = `${formattedDate} - Person: ${personName}\n`;
            fs.appendFile('log.txt', logEntry, (err) => {
                if (err) {
                    console.error('Failed to write to log file', err);
                } else {
                    console.log('Log entry added');
                }
            });

            res.json(result);
        });

        objectRecognitionProcess.stderr.on('data', (data) => {
            console.error(`stderr: ${data}`);
        });

        objectRecognitionProcess.on('close', (code) => {
            if (code !== 0) {
                console.error(`object.py script exited with code ${code}`);
            }
        });
    });

    faceRecognitionProcess.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
    });

    faceRecognitionProcess.on('close', (code) => {
        if (code !== 0) {
            console.error(`cv.py script exited with code ${code}`);
            res.status(500).send('Face recognition processing failed');
        }
    });
});




app.delete('/delete-image', (req, res) => {
    const { filename } = req.query; // Assuming the filename is passed as a query parameter
    const filePath = path.join(uploadDir, filename);

    fs.unlink(filePath, (err) => {
        if (err) {
            console.error('Error deleting file:', err);
            res.json({ success: false, message: 'Failed to delete image' });
        } else {
            console.log('File deleted successfully');
            res.json({ success: true, message: 'Image deleted successfully' });
        }
    });
});   
app.delete('/delete-unknown-image', (req, res) => {
    const { filename } = req.query; // Assuming the filename is passed as a query parameter
    const filePath = path.join(unknownUploadDir, filename);

    fs.unlink(filePath, (err) => {
        if (err) {
            console.error('Error deleting file:', err);
            res.json({ success: false, message: 'Failed to delete image' });
        } else {
            console.log('File deleted successfully');
            res.json({ success: true, message: 'Image deleted successfully' });
        }
    });
});

app.post('/add-location', (req, res) => {
    const { latitude, longitude, address } = req.body;
    const locationString = `<p>Latitude: ${latitude}, Longitude: ${longitude}, Address: ${address}</p>\n`;
    const filePath = path.join(__dirname, 'pages', 'lastLocation.html');

    // Read the existing HTML file
    fs.readFile(filePath, 'utf8', (readErr, data) => {
        if (readErr) {
            console.error('Failed to read file', readErr);
            res.status(500).send('Error reading location file');
            return;
        }

        // Insert the new location string before the closing body tag
        const updatedContent = data.replace(/<\/body>/, `${locationString}</body>`);

        // Write the updated HTML back to the file
        fs.writeFile(filePath, updatedContent, 'utf8', (writeErr) => {
            if (writeErr) {
                console.error('Failed to append location', writeErr);
                res.status(500).send('Error appending location');
                return;
            }

            console.log('Location appended successfully');
            res.send('Location added');
        });
    });
});

app.post('/delete-locations', (req, res) => {
    const filePath = path.join(__dirname, 'pages', 'lastLocation.html');
    
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error('Failed to read file', err);
            return res.status(500).send({message: 'Failed to read file'});
        }

        // Use a regular expression to remove all <p>...</p> tags
        const updatedContent = data.replace(/<p>.*?<\/p>\n/g, '');

        fs.writeFile(filePath, updatedContent, 'utf8', (err) => {
            if (err) {
                console.error('Failed to update file', err);
                return res.status(500).send({message: 'Failed to update file'});
            }

            res.send({message: 'All locations deleted successfully'});
        });
    });
});

app.post('/process-document', upload.single('document'), (req, res) => {
    const scriptPath = 'textToSpeech.py'; // Path to your Python script
    const imagePath = req.file.path;

    // Spawn a child process to run the Python script
    const process = spawn('python', [scriptPath, imagePath]);

    let result = '';

    // Capture the output of the Python script
    process.stdout.on('data', (data) => {
        result += data.toString();
    });

    // Handle the close event of the child process
    process.on('close', (code) => {
        console.log(`Process exited with code ${code}`);
        
        // Send the extracted text back to the client
        res.send(result);
    });
});


const PORT = process.env.PORT || 3000;

// Start server
app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);

});
