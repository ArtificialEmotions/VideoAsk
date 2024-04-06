const express = require('express');
const NodeCache = require('node-cache');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({limit: '50mb'}));
app.use(express.urlencoded({limit: '50mb'}));

let tokenStore = new NodeCache();

const { CLIENT_ID, CLIENT_SECRET, REDIRECT_URI, SCOPES } = process.env;

let accessToken;

async function refreshAccessToken(userId) {
    const refreshToken = tokenStore.get(userId).refresh_token;

    try {
        const tokenResponse = await axios.post(
        'https://api.hubapi.com/oauth/v1/token',
        {
            grant_type: 'refresh_token',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            refresh_token: refreshToken,
        },
        {
            headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        const newAccessToken = tokenResponse.data.access_token;
        const newRefreshToken = tokenResponse.data.refresh_token;

        tokenStore.set(userId, { access_token: newAccessToken, refresh_token: newRefreshToken, expires_at: Math.floor(Date.now() / 1000) + 1800 });

        return newAccessToken;
    } catch (error) {
        console.error('Error refreshing access token:', error.message);
        throw error;
    }
}  

app.get('/authorize', (req, res) => {
    const authorizationUrl = `https://app.hubspot.com/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&scope=contacts%20automation&response_type=code`;
    res.redirect(authorizationUrl);
});

app.get('/callback', async (req, res) => {
    const { code } = req.query;

    try {
        const tokenResponse = await axios.post(
            'https://api.hubapi.com/oauth/v1/token',
            {
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                code,
            },
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );

        accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;

        // Use the access token to get additional information including hubId
        const tokenInfoResponse = await axios.get('https://api.hubapi.com/oauth/v1/access-tokens/' + encodeURIComponent(accessToken));

        const hubId = tokenInfoResponse.data.hub_id;
        const userId = `user_${hubId}`;

        tokenStore.set(userId, { access_token: accessToken, refresh_token: refreshToken, expires_at: Math.floor(Date.now() / 1000) + 1800 });

        console.log('Access Token:', accessToken);
        console.log('Access Token:', userId);

        const PropertyGroupCreate = {
            name: "videoaskapp",
            displayOrder: -1,
            label: "Video Ask Properties"
        };

        try{
            // create video ask group property
            await axios.post(
                'https://api.hubspot.com/crm/v3/properties/contacts/groups',
                PropertyGroupCreate,
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    }
                }
            );
        } catch (error){
            console.log('Error during creating properties - likely already made');
        }

        res.send('Authorization successful!');
    } catch (error) {
      console.error('Error during authorization:', error);
      res.status(500).send('Error during authorization.');
    }
});

app.post('/videoask', async (req, res) => {
    res.status(204).end();

    try{
        const questionsData = req.body.form.questions;
        const answersData = req.body.contact.answers;
        const emailData = req.body.contact.email;
        const fullNameData = req.body.contact.name;

        const firstName = fullNameData.split(' ').shift();
        const surname = fullNameData.split(' ')[1];

        // const userId = `user_144246481`; // localserver
        const userId = `user_26122306`; // client
        let tokens = tokenStore.get(userId);

        if (!tokens) {
            console.error('Tokens not found for user');
            return;
        }

        let { access_token: accessToken, expires_at: expiresAt } = tokens;

        if (!accessToken || !expiresAt) {
            console.error('Access token not found for user');
            return;
        }

        // if it will expire within 60 seconds or less
        if ((expiresAt - Math.floor(Date.now() / 1000)) < 60) {
            console.log('Refreshing access token...');
            const newAccessToken = await refreshAccessToken(userId);
            console.log('New Access Token:', newAccessToken);

            tokens = tokenStore.get(userId);

            if (!tokens) {
            console.error('Tokens not found for user');
            return;
            }

            ({ access_token: accessToken, expires_at: expiresAt } = tokens);

            if (!accessToken || !expiresAt) {
            console.error('Access token not found for user');
            return;
            }
        }

        // Create a map to store question-answer pairs
        const formattedData = {};

        // Iterate through answersData to format data
        answersData.forEach(async answer => {
            const question = questionsData.find(q => q.question_id === answer.question_id);
            if (!question) return; // Skip if corresponding question not found

            // Check if the answer is from a poll
            if (answer.poll_options && answer.poll_options.length > 0) {
                answer.poll_options.forEach(async option => {
                    if (!formattedData[question.title]) {
                        formattedData[question.title] = [];
                    }
                    
                    formattedData[question.title].push(option.content);

                    try{
                        let formattedName = question.title;
                        //lowercase
                        formattedName = formattedName.toLowerCase();
                        // remove space
                        formattedName = formattedName.replace(/\s+/g, '_');
                        // remove special chars
                        formattedName = "videoask_" + formattedName.replace(/[^\w\s]/gi, '_');

                        const poll_properties = {"label":"VideoAsk " + question.title, "type":"string","formField":true,"groupName":"videoaskapp","name":formattedName,"fieldType":"textarea"};

                        await axios.post(`https://api.hubapi.com/crm/v3/properties/contacts`, poll_properties, {
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json'
                            }
                        });
                    } catch(error){
                        console.log('Error during poll API', error);
                    }

                });
            } else if (answer.input_text) { // Check if the answer is from text input
                if (!formattedData[question.title]) {
                    formattedData[question.title] = [];
                }

                formattedData[question.title].push(answer.input_text);

                try{
                    let formattedName2 = question.title;
                    //lowercase
                    formattedName2 = formattedName2.toLowerCase();
                    // remove space
                    formattedName2 = formattedName2.replace(/\s+/g, '_');
                    // remove special chars
                    formattedName2 = "videoask_" + formattedName2.replace(/[^\w\s]/gi, '_');

                    const poll_properties2 = {"label":"VideoAsk " + question.title,"type":"string","formField":true,"groupName":"videoaskapp","name":formattedName2,"fieldType":"textarea"};

                    await axios.post(`https://api.hubapi.com/crm/v3/properties/contacts`, poll_properties2, {
                        headers: {
                            'Authorization': `Bearer ${accessToken}`,
                            'Content-Type': 'application/json'
                        }
                    });
                } catch(error){
                    console.log('Error during poll API', error);
                }
            }
        });

        if(formattedData != {}) {
            // Search for contact
            const getContactId = await axios.post(
                'https://api.hubapi.com/crm/v3/objects/contacts/search',
                {
                filterGroups: [
                    {filters: [{
                        propertyName: 'email',
                        operator: 'EQ',
                        value: emailData
                        }]}]
                },
                {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${accessToken}`
                }
                }
            );
            
            let { results } = getContactId.data;

            // If contact not Found
            if (results && results.length <= 0) {
                // creating a new contact
                const newContact = {
                    properties: {
                        'email': emailData,
                        'firstname':firstName,
                    }
                };

                if(surname != undefined){
                    newContact.properties['lastname'] = surname;
                }

                // POST request to create a new contact
                axios.post('https://api.hubspot.com/crm/v3/objects/contacts', newContact, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    }
                });

                // Search for contact
                const getContactId2 = await axios.post(
                    'https://api.hubapi.com/crm/v3/objects/contacts/search',
                    {
                    filterGroups: [
                        {filters: [{
                            propertyName: 'email',
                            operator: 'EQ',
                            value: emailData
                            }]}]
                    },
                    {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${accessToken}`
                    }
                    }
                );
                
                ({ results } = getContactId2.data);
            }

            const { id } = results[0];

            updateData = {
                properties: {}
            };

            for (const property in formattedData) {
                if (Object.hasOwnProperty.call(formattedData, property)) {
                    const values = formattedData[property];
                    
                    let formattedName3 = property;
                    //lowercase
                    formattedName3 = formattedName3.toLowerCase();
                    // remove space
                    formattedName3 = formattedName3.replace(/\s+/g, '_');
                    // remove special chars
                    formattedName3 = "videoask_" + formattedName3.replace(/[^\w\s]/gi, '_');
            
                    updateData.properties[formattedName3] = values.join(', ');
                }
            }
        
            await axios.patch(`https://api.hubapi.com/crm/v3/objects/contacts/${id}`, updateData, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
            );
        }

        console.log(formattedData);
    } catch (error){
        console.log('Error during /videoask', error);
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});