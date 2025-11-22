document.addEventListener('DOMContentLoaded', () => {
    // Connect to Socket.IO server
    const socket = io();
    
    // DOM elements
    const chatMessages = document.getElementById('chat-messages');
    const userInput = document.getElementById('user-input');
    const sendButton = document.getElementById('send-button');
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    const connectionStatus = document.querySelector('#connection-status');
    
    // Add a message to the chat
    function addMessage(message, sender) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${sender}`;
        
        const messageContent = document.createElement('div');
        messageContent.className = 'message-content';
        messageContent.textContent = message;
        
        messageDiv.appendChild(messageContent);
        chatMessages.appendChild(messageDiv);
        
        // Scroll to the bottom of the chat
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Show typing indicator
    function showTypingIndicator() {
        const typingDiv = document.createElement('div');
        typingDiv.className = 'typing-indicator';
        typingDiv.id = 'typing-indicator';
        
        for (let i = 0; i < 3; i++) {
            const dot = document.createElement('span');
            dot.className = 'typing-dot';
            typingDiv.appendChild(dot);
        }
        
        chatMessages.appendChild(typingDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Remove typing indicator
    function removeTypingIndicator() {
        const typingIndicator = document.getElementById('typing-indicator');
        if (typingIndicator) {
            typingIndicator.remove();
        }
    }
    
    // Handle sending a message
    function sendMessage() {
        const message = userInput.value.trim();
        if (message === '') return;
        
        // Add user message to chat
        addMessage(message, 'user');
        userInput.value = '';
        
        // Show typing indicator
        showTypingIndicator();
        
        // Send message to server
        socket.emit('send-message', message);
    }
    
    // Event listeners
    sendButton.addEventListener('click', sendMessage);
    
    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });
    
    // Socket.io event listeners
    socket.on('connect', () => {
        console.log('Connected to server');
    });
    
    socket.on('connection-status', (status) => {
        console.log('Dialogflow status:', status);
        
        // Update UI based on connection status
        if (status.status === 'connected') {
            connectionStatus.classList.add('connected');
            statusText.textContent = 'Connected to Dialogflow';
        } else {
            connectionStatus.classList.add('error');
            statusText.textContent = `Connection Error: ${status.message}`;
            console.error('Dialogflow connection error:', status.error);
        }
    });
    
    socket.on('receive-message', (data) => {
        // Remove typing indicator
        removeTypingIndicator();
        
        // Add bot's response to chat
        addMessage(data.text, 'bot');
    });
    
    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
        connectionStatus.classList.remove('connected');
        connectionStatus.classList.add('error');
        statusText.textContent = 'Disconnected from server';
    });
    
    // Focus the input field when the page loads
    userInput.focus();
});
