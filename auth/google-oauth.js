/* Copyright © 2015 PointSource, LLC. All rights reserved. */
/*
 * This is an auth service that registers an auth method called "google-oauth".
 *
 * For configuring, include a clientId, clientSecret, and callbackPath, and optional profile.
 *
 * A route will be registered at the callback path that can take an auth code.
 * After authenticating, the request.user object will look like:
 * {
 *  "id": "103117966615020283234",
 *  "email": "user@gmail.com",
 *  "access_token": "..."
 * }
 *
 * If profile === true, then an additional request will be made to get the google profile
 * data and place it in the "profile" field of request.user.
 */
var _ = require('lodash'),
    request = require('request'),
    jwt = require('jsonwebtoken'),
    getRawBody = require('raw-body'),
    winston = require('winston');

var _logger, _cfg;
var TOKEN_URL = 'https://www.googleapis.com/oauth2/v3/token';
var LOGOUT_URL = 'https://accounts.google.com/o/oauth2/revoke';
var PROFILE_URL = 'https://www.googleapis.com/plus/v1/people/me';

var ilog = new (winston.Logger)({
    transports: [
        new (winston.transports.Console)({
            level: 'info', //set to debug to get extra debug
            colorize: true
        })
    ]
});


module.exports.init = function(app, logger, config) {

    _logger = logger;

    _cfg = config.get('google-oauth');

    if (_.keys(_cfg).length === 0) { //not configured
        return;
    }

    if (config.get('express').middleware.indexOf('session') < 0) {
        logger.error('google-oauth requires that session be enabled.');
        return;
    }

    if (!_cfg.clientId) {
        logger.error('Missing clientId for google-oauth');
    }

    if (!_cfg.clientSecret) {
        logger.error('Missing clientSecret for google-oauth');
    }

    if (_cfg.callbackPath) {
        app.all(_cfg.callbackPath, setAuthCodeOnReq, authCodeCallback);
    } else {
        logger.error('Missing callbackPath for google-oauth');
    }

    if (_cfg.signoutPath) {
        app.all(_cfg.signoutPath, signOutUser);
    }

}

//Look for an auth code on a request.
//The code is either stored on a query param, or as a POST body.
//If found, it sets req.code, otherwise continue on.
//Uses raw-body library to get the request body so that bodyParser doesn't have to be configured.
function setAuthCodeOnReq(req, res, next) {
    if (req.query.code) {
        req.code = req.query.code;
        ilog.debug('Found auth code %s on query param', req.code);
        return next();
    }

    getRawBody(req, function(err, string) {
        if (string.toString().length > 0) {
            req.code = string.toString();
            ilog.debug('Found auth code %s in body', req.code);
        }
        next();
    });
}

module.exports.authenticate = function(req, res, next) {
    if (req.session.auth) {
        if (req.session.auth.expiration > Date.now()) {
            //console.log("Hasn't yet expired", "have", (req.session.auth.expiration - Date.now()) / 1000, "seconds" )
            setUserData(req);
            next();
        } else {
            ilog.debug('Access token expired.  Getting new token.');
            var profile = req.session.auth.profile;
            var tokenData = {
                refresh_token: req.session.auth.refresh_token,
                client_id: _cfg.clientId,
                client_secret: _cfg.clientSecret,
                grant_type: 'refresh_token',
                redirect_uri: _cfg.redirectURI
            };

            getToken(tokenData, function (err, authData) {
                if (err) {
                    return next(err);
                }
                req.session.auth = authData;
                if (profile) {
                    req.session.auth.profile = profile;
                }
                setUserData(req);
                next();
            });
        }
    } else {
        res.sendStatus(401); //not authenticated
    }
}

function setUserData(req) {
    var auth = req.session.auth;
    req.user = {
        id: auth.id,
        email: auth.email,
        access_token: auth.access_token
    };

    //profile is optional
    if (auth.profile) {
        req.user.profile = auth.profile;
    }
}


//This gets called when someone hits the auth code callback endpoint
//It expects that a valid google auth code is supplied through either the "code" query param
//or in the request body.  Let's setAuthCodeOnReq handle getting the auth code.
//If anything fails, it returns an error status, otherwise a 200
function authCodeCallback(req, res, next) {
    var code = req.code;
    if (!code) {
        return res.status(400).send('Missing auth code');
    }

    var tokenData = {
        code: code,
        client_id: _cfg.clientId,
        client_secret: _cfg.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: _cfg.redirectURI
    };

    getToken(tokenData, function (err, authData) {
        if (err) {
            res.status(err.statusCode).send(err.message);
        } else {
            req.session.auth = authData;

            if (_cfg.profile === true) { //optional step to get profile data
                getProfileData(authData.access_token, function(err, data) {
                    if (err) {
                        return next(err);
                    }
                    req.session.auth.profile = data;
                    res.sendStatus(200);
                });
            } else {
                res.sendStatus(200);
            }


        }
    });
}

//Revoke the access token, refresh token, and cookies
function signOutUser(req, res, next) {
    ilog.debug('Signing out user');
    //make a best attempt effort at revoking the tokens
    var accessToken = req.session.auth ? req.session.auth.access_token: null;
    var refreshToken = req.session.auth ? req.session.auth.refresh_token: null;
    if (accessToken) {
        ilog.debug('Revoking access token');
        request.get({
            url: LOGOUT_URL,
            qs: {
                token: accessToken
            }
        }, function(err, response, body) {
            if (err) {
                ilog.warn('Error revoking access token', err.message);
            } else {
                ilog.debug('Revoked access token, %s', response.statusCode);
            }
        });
    }

    if (refreshToken) {

        request.get({
            url: LOGOUT_URL,
            qs: {
                token: refreshToken
            }
        }, function (err, response, body) {
            if (err) {
                ilog.warn('Error revoking refresh token', err.message);
            } else {
                ilog.debug('Revoked refresh token, %s', response.statusCode);
            }
        });
    }
    delete req.session.auth;
    res.sendStatus(200);
}

/**
 * Makes a call to the google token service using the given data
 *
 * Data should either have a grant type of refresh_token or authorization_code
 * Callback is of the form callback(err, result) where result contains some auth data, such as
 * id, email, access_token, expiration, and refresh_token
 * @param data
 * @param callback
 */
function getToken(data, callback) {

    request.post({url: TOKEN_URL, form: data}, function (err, resp, body) {

        if (resp.statusCode !== 200) { //error
            return callback({statusCode: resp.statusCode, message: body});
        } else {
            ilog.debug('Got response back from token endpoint', body);
            /*
             Body should look like
             {
             "access_token": "ya29.UQH0mtJ5M-CNiXc-mDF9II_R7CRzRQm6AmxIc6TjtouR_HxUtg-I1icHJy36e065UUmIL5HIdfBijg",
             "token_type": "Bearer",
             "expires_in": 3600,
             "refresh_token": "1/7EBZ1cWgvFaPji8FNuAcMIGHYj3nHJkNDjb7CSaAPfM",
             "id_token": "..."
             }
             */
            var authData = JSON.parse(body);

            //id_token is a JWT token.  Since we're getting this directly from google, no need to authenticate it
            var idData = jwt.decode(authData.id_token);

            /*
             Sample id data
             { iss: 'accounts.google.com',
             sub: '103117966615020283234',
             azp: '107463652566-jo264sjf04n1uk17i2ijdqbs2tuu2rf0.apps.googleusercontent.com',
             email: 'foo@gmail.com',
             at_hash: 'qCF-HkLhiGtrHgv6EsPzQQ',
             email_verified: true,
             aud: '107463652566-jo264sjf04n1uk17i2ijdqbs2tuu2rf0.apps.googleusercontent.com',
             iat: 1428691188,
             exp: 1428694788 }
             */
            callback(null, {
                id: idData.sub,
                email: idData.email,
                access_token: authData.access_token,
                expiration: Date.now() + (1000 * authData.expires_in),
                refresh_token: authData.refresh_token || data.refresh_token
            });
        }
    });
}

function getProfileData(token, callback) {
    request.get(PROFILE_URL, {'auth': {'bearer': token}},
        function (err, resp, body) {
            if (err) {
                return callback(err);
            }
            callback(null, JSON.parse(body));
        }
    );
}