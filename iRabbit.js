"use strict";

var EventEmitter = require( "events" ).EventEmitter
  , amqp = require('amqplib')
  , util = require('util')
  , assert = require( 'assert' )
  , _ = require( 'underscore' )
  , when = require('when')
  , uuid = require('node-uuid')
  , log4js = require('log4js')
;

var logCalls = false;

/**
 * Внутренний метод, создающий экземпляр объекта iRabbit. Используется в методе Singletone
 *
 * @param  {object} config   config object - see Singletone method
 * @return {null}            there is no retuen value
 */
function iRabbit( config ) {
    // Config log4js
    var log4jsConf = {},
        log4jsConfDef = {
          "appenders": [
            { "type": "console" }
            // , { "type": "file", "filename": "logs/log-calls.log", "category": "logCalls" }
          ]
          , "replaceConsole": true
        };
    if( typeof(config.log4js)!='undefined' )
        log4jsConf = _.extend(log4jsConfDef, config.log4js);
    else
        log4jsConf = log4jsConfDef;
    log4js.configure( log4jsConf );
    logCalls = log4js.getLogger('logCalls');
    // logCalls.setLevel('debug');
    // Config log4js

    // logCalls.info('iRabbit constructor', config);
    assert.equal(typeof (config), 'object',    "config object expected");
    assert.equal(typeof (config.connection), 'object',    "config.connection object expected");
    assert.equal(typeof (config.connection.url), 'string',    "config.connection.url string expected");

    EventEmitter.call(this);
    this._config = config;
    this._enity = {};

    this.amqp = amqp;
    this.connection = false;
    this._channel = false;
    this._channels = {};
    this._uniqId = uuid();
}

util.inherits(iRabbit, EventEmitter);

var singleton = {};
/**
 * Синглтоню модуль по объекту конфигурации
 * @param  {object} config конфигурация
 *                         Например: "{ connection : { url: 'amqp://guest:guest@localhost:5672' } }"
 * @return {object}        экземпляр класса iRabbit
 */
module.exports = function Singleton( config ){
    var hashCode = makeHash( config );
    if (singleton[hashCode]) return singleton[hashCode];
    if (!(this instanceof iRabbit))
        return singleton[hashCode] = new iRabbit(config, hashCode);
};

/**
 * метод воединения с кроликом. ВЫзывать в рукопашную не нужно - вызывается сам при необходимости
 * @return {promise} результат amqplib connect
 */
iRabbit.prototype.connect = function() {
    // logCalls.info('iRabbit connect', this._config.connection);
    var hashCode = 'connection'+makeHash(this._config.connection);
    // console.log('connection entity:',hashCode, this._enity[hashCode]);
    if( typeof(this._enity[hashCode])=='undefined' || !this._enity[hashCode] ){
        var url = this._config.connection.url;
        var opts = this._config.connection; //delete opts.url;
        this._enity[hashCode] = amqp.connect( url, opts );
        this._enity[hashCode] . then(
            function onConnect( connection ){
                this.connection = connection;
                process.once('SIGINT', function() { connection.close(); });
                return this.connection;
            }.bind(this)
        ) . catch( function( err ){
            return when.reject(err);
        });
    }
    return this._enity[hashCode];
}

/**
 * Close RabbitMq connection
 * @return {boolean}
 */
iRabbit.prototype.close = function() {
    // logCalls.info('iRabbit close');
    //Не могу понять почему, но если вызывать close в sendQueue.then - сообщение не доставляется в очередь
    setTimeout( function(){
        for( var hash in this._channels ){
            this._channels[hash].close();
        }
        if( this.connection ) this.connection.close();
    }.bind(this), 200 );
}

/**
 * UPDATE:
 *    > переделано - всегда выдается один канал.
 *    > Не вижу конфликта, т.к. канал - виртуальное соединение внутри реального ( http://stackoverflow.com/questions/18418936/rabbitmq-and-relationship-between-channel-and-connection )
 *
 * Создание канала. Само по себе создание каналы смысла не имеет.
 * Канал создается для какой-то очереди или темы по этому метод принимает параметры идентифицирующие сущность для которой создается канал.
 * @param  {string} forEntityType   тип сущности [queue|exchange]
 * @param  {string} forEntityName   имя сущности
 * @param  {boolean} confirmChannel (optional) if true - creates ConfirmChannel (default - false) http://www.squaremobius.net/amqp.node/channel_api.html#model_createConfirmChannel
 * @return {promise}                Промис
 */
iRabbit.prototype.channel = function( forEntityType, forEntityName, confirmChannel ) {
    // logCalls.info('iRabbit channel');
    if( arguments.length == 1 && typeof(forEntityType) == 'boolean' ){
        confirmChannel = forEntityType;
    }
    forEntityType = ( typeof(forEntityType) != 'undefined' ) ? forEntityType : '';
    forEntityName = ( typeof(forEntityName) != 'undefined' ) ? forEntityName : '';
    confirmChannel = ( typeof(confirmChannel) == 'undefined' ) ? false : true ;

    return this.connect().then(function connected( connection ){

            // var hashCode = 'channel'+makeHash( (forEntityType.toString())+(forEntityName.toString())+(confirmChannel.toString()) );
            var hashCode = 'channel'; //Потому что не вижу конфликта в использовании одного канала одновременно для очередей и эксченджей
            if( typeof(this._enity[hashCode])=='undefined' || !this._enity[hashCode] ){
                // console.log(' --- ',hashCode, forEntityType, forEntityName, confirmChannel);
                if( confirmChannel ){
                    this._enity[hashCode] = this.connection.createConfirmChannel();
                } else {
                    this._enity[hashCode] = this.connection.createChannel();
                }

                this._enity[hashCode].then(function(channel){
                    this._channel = channel;
                    this._channels[hashCode] = channel;
                    // console.log('channel',this._channel);
                }.bind(this))
                 . catch( function(err){ return when.reject(err); } );;
            }

            return this._enity[hashCode];
        }.bind(this)
    ) . catch( function( err ){ return when.reject(err); } );
}

/*************************
 *          Queue
 *    Работа с очередями
 *************************/

/**
 * Создание очереди
 * @param  {string} name    название очереди, может быть пустой строкой (в этом случае название будет сформировано автоматически)
 * @param  {object} options (optional) параметры создания очереди для amqplib.assertQueue ( http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertQueue )
 *                          не стандартные параемтры в составе options:
 *                          - catchExpired (bool) если true - инициируется механизм обработки не доставленных сообщений (сообщения, которые из очереди не ушли подписчику в течении expiration)
 * @return {promise}        результат работы amqplib.assertQueue
 */
iRabbit.prototype.initQueue = function( name, options ){

    assert.equal(typeof (name), 'string',    "name string expected");

    // logCalls.info('iRabbit initQueue', name);
    //apply default options
    var defOptions = {
        'durable':false,
        'exclusive':false,
        'autoDelete':true,
        // 'deadLetterExchange':'defaultDeadLetterExchange'
    };

    if( typeof(options) == 'undefined' ) options = defOptions;
    else options =  _.extend(defOptions, options);


    return this.channel( 'queue', name ).then( function channelInited( channel ){
            var hashCode = (name=='') ? false : 'queue' + name;

            if( hashCode && typeof(this._enity[hashCode])!='undefined' ) return this._enity[hashCode];

            // var queueAssertRes = false;
            return channel.assertQueue( name, options )
                .then( function( queueAssertRes ){

                    if(hashCode) this._enity[hashCode] = queueAssertRes;

                    // init deadLetterExchange if need
                    if(
                        typeof(options.deadLetterExchange)!='undefined' ||
                        typeof(options.deadLetterRoutingKey)!='undefined'
                    ) options.catchExpired = true;

                    if( typeof(options.catchExpired)!='undefined' ){
                        if( typeof(options.deadLetterExchange) == 'undefined' ){ options.deadLetterExchange = this.getDefaultDeadletterExchange(); }
                        if( typeof(options.deadLetterRoutingKey) == 'undefined' ){ options.deadLetterRoutingKey = this.getDefaultDeadletterRoutingKey( name ); }
                        this.initTopic( options.deadLetterExchange )
                        .then( function(){
                            return queueAssertRes;
                        } );
                    }

                    return queueAssertRes;

                }.bind(this))
                .catch( function(err){ return when.reject(err); } );

            // return queueAssertRes;
        }.bind(this)
    ) . catch( function(err){ return when.reject(err); } );
}

iRabbit.prototype.getDefaultDeadletterExchange = function(){
    return 'defaultDeadLetterExchange';
}

iRabbit.prototype.getDefaultDeadletterRoutingKey = function( name ){
    return 'default.expired.'+ ( (name=='')?'queue':name ) ;
}

/**
 * Создать (если еще не создана) и подписаться на очередь
 * @param  {string} name    назание очереди
 * @param  {object} options (optional) набор параметров,
 *                          - в случае создания и подписки { init: ..., consume: ... }
 *                          - в случае просто подписки { consume: ... }
 *                          init - опции для amqplib.assertQueue ( http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertQueue )
 *                          consume - опции для amqplib.consume (http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume)
 *                          Параметры, не стандартные для amqplib:
 *                          Секция consume обрабатывает опции:
 *                           - eventName:   часть имени события ("<eventName>:message"), возникающего при входящем сообщении
 *                           - prefetch:    передается в случае, если нужно выставить prefetch для очереди (http://www.squaremobius.net/amqp.node/channel_api.html#channel_prefetch)
 *                           - reseiveType: определяет поле "type" в событии "receive" возникающем, при входящем сообщении.
 *
 * @return {promise}        promise, который разрешается в объект {
 *                                   'queue':   <resolved promise of assertQueue>,
 *                                   'consume': <resolved promise of consume>,
 *                                   'channel': <resolved promise of createChannel>
 *                                   Не стандартные для qmqplib параметры:
 *                                   consume.manualAck - указывает, что при получении соообщения не нужно автоматически слать ACK подтверждение.
 *                                                       при этом обязанность отправить подтверждение (amqplib.ack) ложиться на программу использующую эту библиотеку.
 *                                                       ________
 *                                                       этот подход может использоваться если необходимо отправить подверждение только после завершения обработки текущего сообщения.
 *                                                       самое логичное место вызова ack - в конце функции обработчика входящего сообщения, перед возвратом результата.
 *
 * @events                  При получении вход. сообщения на слушаемую очередь на экземпляре iRabbit возникают события:
 *     событие receive
 *     В качестве аргумента принимает объект: {
 *                 type : <тип входящего сообщения>,
 *                 name : eventName,
 *                 queueName : queueName,
 *                 message : unpackedMessage ,
 *                 messageObj : message,
 *                 channel : channel,
 *                 eventName : eventName
 *     }
 *     событие <name>:message {
 *                 queueName : queueName,
 *                 message : unpackedMessage ,
 *                 messageObj : message,
 *                 channel : channel,
 *                 eventName: eventName
 *     }
 *
 */
iRabbit.prototype.subscribeQueue = function( name, options ){
    assert.equal(typeof (name), 'string',    "name string expected");

    // logCalls.info('iRabbit subscribeQueue', name);

    var initOptions = (options && typeof(options.init)!='undefined' ) ? _.extend({},options.init) : {} ;
    var subscribeOptions = (options && typeof(options.consume)!='undefined') ? _.extend({},options.consume) : {} ;

    var locChannel = false,
        queueHash = 'queue'+name;


    /*return this.initQueue( name, initOptions ).then(function( queue ){
        return this._consumeQueue( queue, subscribeOptions );
    }.bind(this))
    .catch( function(err){
        // console.log('here');
        return when.reject(err);
    } );*/
    if( typeof( this._enity[queueHash] )=='undefined' || !this._enity[queueHash] ){
        // Если очередь еще не инициализирована - ожидаются отдельные параметры для инита и подписи
        return this.initQueue( name, initOptions ).then(function( queue ){
            return this._consumeQueue( queue, subscribeOptions );
        }.bind(this))
        .catch( function(err){
            // console.log('here');
            return when.reject(err);
        } );
    } else {
        // Очередь инициализирована - ожидаются параметры только для подписи
        return this._enity[queueHash].then(function(queue){
            return this._consumeQueue( queue, subscribeOptions);
        }.bind(this))
        .catch( function(err){ return when.reject(err); } );
    }

    return when.reject( new Error('unexpected situation') );
}

/**
 * internal func - consume queue by passing channelObj, queueObj, consumeoptions
 * @param  {object} channel amqplib channel
 * @param  {object} queue   amqplib queue
 * @param  {object} options (optional) опции для amqplib.consume (http://www.squaremobius.net/amqp.node/channel_api.html#channel_consume)
 * @return {promise}        promise, результат amqplib.consume
 */
iRabbit.prototype._consumeQueue = function ( queue, options ){
    var queueName = queue.queue,
        locChannel = false,
        eventName = queueName+':message';

    if( options && typeof(options.eventName)!='undefined' ){
        eventName = options.eventName;
        // console.log('eventName',eventName);
        delete options.eventName;
    }
    // console.log('_consumeQueue options:', options);
    return this.channel('queue', queueName)
    .then(function( channel ){
        // console.log('_consumeQueue consume:', channel);
        locChannel = channel;

        if( typeof(options.prefetch)!='undefined' ){
            // console.log('prefetching',options.prefetch);
            var p = parseInt(options.prefetch);
            if( p > 0 ) channel.prefetch( p );
            delete options.prefetch;
        }
        // console.log('-- consume',queueName, 'eventName', eventName,'options', options);
        return channel.consume(
            queueName,
            function ConsumeCallback( message ){ // коллбэк ф-я приема сообщений

                // console.log( '>>> ConsumeCallback', eventName, message.properties.correlationId ,   message.content.toString() );

                var unpackedMessage = _unpackData( message );

                // console.log('emit(312)',eventName);

                this.emit( 'receive',{
                    'type' : ( typeof(options.reseiveType)=='string'? options.reseiveType : 'queue' ),
                    'name' : eventName,
                    'queueName' : queueName,
                    'message' : unpackedMessage ,
                    'messageObj' : message,
                    'channel' : channel
                });
                this.emit( eventName, {
                    'queueName' : queueName,
                    'message' : unpackedMessage ,
                    'messageObj' : message,
                    'channel' : channel
                });

                if(
                    ( typeof(options.noAck)=='undefined' || !options.noAck  ) &&
                    ( typeof(options.manualAck) == 'undefined' || !options.manualAck )
                ){
                    channel.ack( message );
                }
            }.bind(this),
            options
        )
        .then( function(res){
            // console.log(res);
            return res;
        } )
        .catch( function(err){
            // console.log('errrrrr');
            return when.reject(err);
        } );
    }.bind(this) )
    .then( function( consume ){
        return {
            'queue':queue,
            'consume':consume,
            'channel':locChannel,
            'eventName':eventName
        };
    })
    .catch( function(err){
        console.log('errrrrr222', err);
        return when.reject(err);
    } );
}

/**
 * Метод отправляет сообщение в очередь. Если очередь не была создана - создает.
 * @param  {string} name    название очереди
 * @param  {mixed}  message отправляемое сообщение
 * @param  {object} options (optional) объект с хешами {
 *                              init : <опции для amqplib.assertQueue>
 *                              send : <опции для amqplib.sendToQueue>
 *                          }
 *                          Если вызывается для отправки в уже инициированую ранее очередь - init не используется
 * @return {boolean}        Результат работы метода amqplib.sendToQueue (http://www.squaremobius.net/amqp.node/channel_api.html#channel_sendToQueue)
 */
iRabbit.prototype.sendQueue = function( name, message , options ) {
    assert.notEqual(typeof (message), 'undefined' , "message expected" );
    assert.equal(typeof (name), 'string',    "name string expected");

    // logCalls.info('iRabbit sendQueue', name);

    if( typeof(options) == 'undefined' ) options = {};
    var initOptions = typeof(options.init)!='undefined' ? _.extend({},options.init) : {} ;
    var sendOptions = typeof(options.send)!='undefined' ? _.extend({},options.send) : {} ;

    var locChannel = false,
        queueHash = 'queue'+name;

    if( typeof( this._enity[queueHash] )=='undefined' || !this._enity[queueHash] ){
        // Если очередь еще не инициализирована - ожидаются отдельные параметры для инита и отправки
        return this.initQueue( name, initOptions ).then(function( queue ){

            return this._sendQueue(
                    queue,
                    message,
                    sendOptions
            );
        }.bind(this))
        .catch( function(err){ return when.reject(err); } );

    } else {
        // Очередь инициализирована - ожидаются параметры только для подписи
        return this._sendQueue(
                this._enity[queueHash].queue,
                message,
                sendOptions
            );
        /*return this._enity[queueHash].then( function( queue ){

            return this._sendQueue(
                queue,
                message,
                sendOptions
            );
        }.bind(this) )
        .catch( function(err){ return when.reject(err); } );*/
    }

    return when.reject( new Error('unexpected situation') );
}

/**
 * Внутренний метод - выполняет черновую работу по отправке сообщения. используется методом sendQueue
 */
iRabbit.prototype._sendQueue = function( queue, message, optionsLoc ){

    var packed = _packData(message);
    message = packed.data;

    var options = _.extend({},optionsLoc);

    options.contentType = packed.mime;
    options.contentEncoding = 'UTF8';

    var queueName = ( typeof(queue)=='string' ) ? queue : queue.queue;

    return this.channel('queue', queueName).then(function( channel ){


        return channel.sendToQueue(queueName, message, options);
    }.bind(this) )
    .catch( function(err){ return when.reject(err); } );
}

/*************************
 *     Exchange topic
 * Работа с topic exchange
 *************************/

/**
 * инициализацтя topic echange
 * @param  {string} name    название exchange
 * @param  {object} options (optional) опции для метода amqplib.assertExchange (http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertExchange)
 * @return {promise}        результат работы amqplib.assertExchange
 */
iRabbit.prototype.initTopic = function( name, options ) {
    assert.equal(typeof (name), 'string',    "name string expected");

    // logCalls.info('iRabbit initTopic', name);

    //apply default options
    var defOptions = {
        'durable' : false,
        'internal' : false,
        'exclusive' : false,
        'autoDelete' : true
    };

    if( typeof(options) == 'undefined' ) options = defOptions;
    else options =  _.extend(defOptions, options);

    return this.channel( 'exchange', name ).then( function channelInited( channel ){
        var hashCode = 'exchange' + name;

        if( typeof(this._enity[hashCode])!='undefined' ) return this._enity[hashCode];

        this._enity[hashCode] = channel.assertExchange( name, 'topic' , options );

        return this._enity[hashCode];
    }.bind(this))
    .catch( function(err){ return when.reject(err); } );
}

/**
 * Метод отправляет сообщение в обменник. Если обменник еще не был инициализирован - инициализирует
 * @param  {string} exchangeName название обменника
 * @param  {string} routingKey   "магический ключ пути"
 * @param  {mixed}  message      отправляемое сообщение
 * @param  {object} options      набор опций {
 *                                   init : <для метода amqplib.assertExchange> (http://www.squaremobius.net/amqp.node/channel_api.html#channel_assertExchange)
 *                                   send : <для метода amqplib.publish> (http://www.squaremobius.net/amqp.node/channel_api.html#channel_publish)
 *                               }
 * @return {promise}             результат работы amqplib.publish
 */
iRabbit.prototype.sendTopic = function( exchangeName, routingKey, message,  options ) {

    assert.equal(typeof (exchangeName), 'string',    "exchangeName string expected");
    assert.equal(typeof (routingKey), 'string',    "routingKey string expected");
    assert.notEqual(typeof (message), 'undefined' , "message expected" );

    // logCalls.info('iRabbit sendTopic', exchangeName, routingKey);

    var initOptions = ( options && typeof(options.init)!='undefined' ) ? _.extend({},options.init) : {} ;
    var sendOptions = ( options && typeof(options.send)!='undefined' ) ? _.extend({},options.send) : {} ;

    var locChannel = false,
        exchangeHash = 'exchange' + exchangeName;

    if( typeof( this._enity[ exchangeHash ] )=='undefined' || !this._enity[ exchangeHash ] ){
        //обменник еще не создан

        return this.initTopic( exchangeName, initOptions ).then(function( exchange ){
            return this.channel( 'exchange', exchange.exchange ).then(function( channel ){
                locChannel = channel;
                return this._sendExchange(
                    channel,
                    exchange,
                    message,
                    routingKey,
                    sendOptions
                );
            }.bind(this) )
            .catch( function(err){ return when.reject(err); } );
        }.bind(this))
        .catch( function(err){ return when.reject(err); } );

    } else {
        //обменник уже создан

        return this.channel( 'exchange', exchangeName )
        .then(function( channel ){
            locChannel = channel;

            return this._enity[ exchangeHash ].then( function( exchange ){
                return this._sendExchange(
                    channel,
                    exchange,
                    message,
                    routingKey,
                    sendOptions
                );
            }.bind(this));
        }.bind(this) )
        .catch( function(err){ return when.reject(err); } );
    }

    return when.reject( new Error('unexpected situation') );
}

iRabbit.prototype._sendExchange = function( channel, exchange, message, routingKey, optionsLoc ){

    var packed = _packData(message);

    var options = typeof(optionsLoc)=='object'? _.extend({},optionsLoc) : {};
    options.contentType = packed.mime;
    options.contentEncoding = 'UTF8';
    // console.log('-- send exchange: ',exchange.exchange, routingKey, options);
    return channel.publish(
        exchange.exchange,
        routingKey,
        packed.data,
        options
    );
}

iRabbit.prototype.addListener = function( eventKey, listener ){
    _addListener.bind(this)( eventKey, listener );
}

/**
 * Метод "подписывается" на обменник (создает очередь, связывает ее с обменником по routingKey)
 * Если обменник еще не инициирован - инициирует
 * @param  {string} name       название обменника
 * @param  {string} routingKey "ключ" слушания обменника
 * @param  {object} options    {
 *                                 initTopic : <для amqplib.assertTopic>
 *                                 initQueue : <для amqplib.assertQueue>
 *                                 consumeQueue : <для amqplib.consume>
 *                             }
 * @return {promise}           комплексный ответ {
 *                                         'queue':<рез-тат работы amqplib.assertQueue>,
 *                                         'consume':<рез-тат работы amqplib.consume>,
 *                                         'bind':<рез-тат работы amqplib.bind>,
 *                                         'channel':<используемый канал>,
 *                                         eventName: <часть имени события (до ":message"), которое будет иметировано при входящем сообщении>
 *                             }
 */
iRabbit.prototype.subscribeTopic = function( name, routingKey, options ){
    assert.equal(typeof (name), 'string',    "name string expected");
    assert.equal(typeof (routingKey), 'string',    "routingKey string expected");

    // logCalls.info('iRabbit subscribeTopic', name, routingKey);

    if( typeof(options)=='undefined' ) options = {};
    var exchangeOptions = typeof(options.initTopic)!='undefined' ? options.initTopic : {} ;
    var queueInitOptions = typeof(options.initQueue)!='undefined' ? options.initQueue : {} ;
    var queueConsumeOptions = typeof(options.consumeQueue)!='undefined' ? options.consumeQueue : {} ;

    var locChannel = false,
        locExchange = false,
        exchangeHash = 'exchange' + name;
    if( typeof( this._enity[exchangeHash] )=='undefined' || !this._enity[exchangeHash] ){
        //exchange еще не создана

        return this.initTopic( name, exchangeOptions ).then(function( exchange ){
            locExchange = exchange;
            return this._createBindSubscribeQueue( exchange, routingKey, {init:queueInitOptions, consume:queueConsumeOptions} );

        }.bind(this))
        .catch(function( err ){
            return when.reject( err );
        });

    } else {
        //exchange есть

        return this._enity[exchangeHash].then( function(exchange){
            return this._createBindSubscribeQueue( exchange , routingKey , {init:queueInitOptions, consume:queueConsumeOptions} );
        }.bind(this) )
    }

    return when.reject( new Error('unexpected situation') );
}

/**
 * Внутренний метод создает очередь, подписываетсяна нее и связывает с exchange по toutingKey
 */
iRabbit.prototype._createBindSubscribeQueue = function( exchange, routingKey, options ){

    assert.equal(typeof (exchange), 'object',    "exchange object expected");
    assert.equal(typeof (routingKey), 'string',    "routingKey string expected");

    if( typeof(options) == 'undefined' ) options = {};
    var initQueueOptions = ( typeof( options.init ) != 'undefined' ) ? _.extend({},options.init) : {},
        subscribeQueueOptions = ( typeof( options.consume ) != 'undefined' ) ? _.extend({},options.consume) : {};

    var queueName = ''
      , locQueue = false
      , locQueueConsume = false
      , locQueueSubscribe = false
      , locChannel = false
      , locEventName = false
      ;

    subscribeQueueOptions.reseiveType = 'topic';

    if( typeof( initQueueOptions.name ) != 'undefined' ){
        queueName = initQueueOptions.name;
        delete initQueueOptions.name;
    } else
        subscribeQueueOptions.eventName = exchange.exchange;

    return this.subscribeQueue( queueName, {init:initQueueOptions, consume:subscribeQueueOptions} )
    .then(function( result ){
        locQueue = result.queue;
        locQueueConsume = result.consume;
        locEventName = result.eventName;

        // get channel
        return this.channel('exchange'+exchange.exchange)
        .then(function(channel){
            locChannel = channel;
            return channel.bindQueue( result.queue.queue, exchange.exchange, routingKey );
        }.bind(this)).catch(function(err){ return when.reject(err) });
    }.bind(this))
    .catch(function(err){ return when.reject(err) })
    .then( function( bindRes ){
        return {
            'queue':locQueue,
            'consume':locQueueConsume,
            'bind':bindRes,
            'channel':locChannel,
            'eventName':locEventName
        };
    });
}

/*************************
 *        RPC queue
 * Паттерн RPC на очередях
 *************************/

/**
 * Метод создания RPCQueue сервера.
 * Создает входящую очередь, подписывается на нее, при получении ответа автоматически отправляет его в replyTo очередь c переданным correlationId
 * @param  {string}     queueName   Название входящей очереди
 * @param  {function}   eventFunc   ф-я обработчик входящего сообщения. Должна возвращать обратное сообщение или промис, который разрешается в обратное сообщение
 * @param  {object}     options     {
 *                                      init : <для amqplib.assertQueue>
 *                                      consume : <для amqplib.consume>
 *                                      response : <для amqplib.sendToQueue>
 *                                  }
 * @return {promise}                результат subscibeQueue
 * @events
 *
 */
iRabbit.prototype.rpcQueueServer = function( queueName, eventFunc, options ){
    assert.equal(typeof (queueName), 'string',    "queueName string expected");
    assert.equal(typeof (eventFunc), 'function',    "eventFunc function expected");

    // logCalls.info('iRabbit rpcQueueServer', queueName);

    if( typeof(options)=='undefined' ) options = {};
    var queueInitOptions = ( typeof options.init != 'undefined') ? _.extend({},options.init) : {},
        queueConsumeOptions = ( typeof options.consume != 'undefined') ? _.extend({},options.consume) : {},
        queueResponseOptions = ( typeof options.response != 'undefined') ? _.extend({},options.response) : {};

    if( typeof(queueConsumeOptions.noAck) == 'undefined' )
        queueConsumeOptions.noAck = false;
    if( typeof(queueConsumeOptions.prefetch) == 'undefined' )
        queueConsumeOptions.prefetch = 1;


    return this.subscribeQueue( queueName, {init:queueInitOptions, consume:queueConsumeOptions} )
        .then(function( result ){

            /*this.on( 'receive', function(incObj){
                    console.log('RECEIVED: ',incObj.type, incObj.name, incObj.message);
            });*/

            _addListener.bind(this)(
                result.queue.queue+':message',
                function(incMsg){
                    // console.log(result.queue.queue+':message');
                    return _processRPC.bind(this)( incMsg, eventFunc, queueResponseOptions )
                    .catch(function(err){ return when.reject(err) });

                }.bind(this)
            );

            // ???
            return when.resolve(result);

        }.bind(this))
        .catch(function(err){ return when.reject(err) });
}

/**
 * Метод для создания екземпляра RPCQueue клиента
 *
 * @param  {string}     serverQueueName имя входящей очереди RpcQueue сервера
 * @param  {function}   responceFunc    (optional) ф-я обработчик ответа от RpcQueue сервера
 * @param  {obejct}     options         (optional) опции для конйигурации клиента
 *                                      {
 *                                          initServerQueue : <опции инициализации вход. очереди RpcQueue сервера amqplib.assertQueue>
 *                                          initCallbackQueue : <опции для инициализации коллюэк очереди iRabbit.subscribeQueue>
 *                                          consumeCallbackQueue : <опции для amqplib.consume коллюэк очереди>
 *                                      }
 * @return {promise}                    promise, который разрешается в экземпляр объекта клиента
 *                                      В возвращаемом клиенте реализован метод send - отправка сообщения RpcQueue серверу (см. подробнее объект RpcQueueClient)
 */
iRabbit.prototype.rpcQueueClient = function( serverQueueName, responceFunc, options ){

    assert.equal(typeof (serverQueueName), 'string',    "serverQueueName string expected");
    if( typeof(responceFunc) == 'undefined' ) responceFunc = function( message ){};

    // logCalls.info('iRabbit rpcQueueClient', serverQueueName);

    var serverQueueOptions = (options && typeof options.initServerQueue != 'undefined') ? _.extend({},options.initServerQueue) : {},
        callbackQueueOptions = (options && typeof options.initCallbackQueue != 'undefined') ? _.extend({},options.initCallbackQueue) : {},
        callbackQueueConsumeOptions = (options && typeof options.consumeCallbackQueue != 'undefined') ? _.extend({},options.consumeCallbackQueue) : {},
        sendOptions = (options && typeof options.send != 'undefined') ? _.extend({},options.send) : {};

    if( typeof(callbackQueueOptions.exclusive) == 'undefined' )
        callbackQueueOptions.exclusive = true;
    if( typeof(callbackQueueConsumeOptions.noAck) == 'undefined' )
        callbackQueueConsumeOptions.noAck = true;

    var hashCode = 'prcQueueClient' + serverQueueName;

    if( typeof(this._enity[hashCode])=='undefined' || !this._enity[hashCode] ){

        var deferred = when.defer();
        this._enity[hashCode] = deferred.promise;
        this._enity[hashCode].then(function( client ){
            this._enity[hashCode] = client;
        }.bind(this));

        return this.initQueue( serverQueueName,serverQueueOptions )
        .then( function( serverQueue ){
            //counsume callback queue
            return this.subscribeQueue('', {init:callbackQueueOptions, consume:callbackQueueConsumeOptions} )
            .then( function( subscribeRes ){
                // console.log('[!]new client');
                // this._enity[hashCode] = new RpcQueueClient( this, serverQueue, subscribeRes.queue, sendOptions );
                deferred.resolve( new RpcQueueClient( this, serverQueue, subscribeRes.queue, sendOptions ) );

                /*_addListener.bind(this)( 'receive', function(incObj){
                    console.log('receive event ',incObj.name);
                });*/

                _addListener.bind(this)(
                    subscribeRes.queue.queue+':message',
                    function(message){
                        responceFunc(message);
                        _received.bind( this._enity[hashCode] )( message );
                    }.bind(this)
                );

                return this._enity[hashCode];
            }.bind(this) )
            .catch( function(err){ return when.reject(err); } );

        }.bind(this) )
        .catch( function(err){ return when.reject(err); } );
    } else {
        return when.resolve( this._enity[hashCode] );
    }


    return when.reject('PRC Queue Client create fail');
}


/**
 * RPC topic
 */
iRabbit.prototype.rpcTopicServer = function( exchangeName, routingKey, eventFunc, options ){
    assert.equal(typeof (exchangeName), 'string',    "exchangeName string expected");
    assert.equal(typeof (routingKey), 'string',    "routingKey string expected");
    assert.equal(typeof (eventFunc), 'function',    "eventFunc function expected");

    // logCalls.info('iRabbit rpcTopicServer', exchangeName, routingKey);

    var topicInitOptions = (options && typeof options.initTopic != 'undefined') ? _.extend({},options.initTopic)  : {},
        queueInitOptions = (options && typeof options.initQueue != 'undefined') ? _.extend({},options.initQueue) : {},
        queueConsumeOptions = (options && typeof options.consumeQueue != 'undefined') ? _.extend({},options.consumeQueue) : {},
        queueResponseOptions = (options && typeof options.response != 'undefined') ? _.extend({},options.response) : {};

        // Сервер безусловно инициирует создание ексченджа обработки мертвых сообщений
        // ИМЯ topic для expired определяется в инициализации очереди, для того чтобы оно было едино для всех
        if( typeof(queueInitOptions.deadLetterExchange) == 'undefined' )
            queueInitOptions.deadLetterExchange = this.getDefaultDeadletterExchange();
        if( typeof(queueInitOptions.deadLetterRoutingKey) == 'undefined' )
            queueInitOptions.deadLetterRoutingKey = this.getDefaultDeadletterRoutingKey();
        if( typeof(queueInitOptions.messageTtl) == 'undefined' )
            queueInitOptions.messageTtl = 30000; //по умолчанию TTL сообщения 30 сек.

    if( typeof(queueInitOptions.name)=='undefined' ){
        // queueInitOptions.name = 'cbServer' + exchangeName+routingKey;
        queueInitOptions.name = '';
    }

    if( typeof(queueConsumeOptions.noAck)=='undefined' )
        queueConsumeOptions.noAck = false;
    if( typeof(queueConsumeOptions.prefetch)=='undefined' )
        queueConsumeOptions.prefetch = 1;
    // console.log('server queueInitOptions',queueInitOptions);
    return this.subscribeTopic( exchangeName, routingKey, {initTopic:topicInitOptions, initQueue:queueInitOptions, consumeQueue:queueConsumeOptions} )
    .then(function( result ){
        // console.log('---subscribeTopic result:', result.eventName);
        // add event listener for message
        _addListener.bind(this)(
            result.eventName,
            function(incMsg){
                return _processRPC.bind(this)( incMsg, eventFunc, queueResponseOptions )
                .catch(function(err){ return when.reject(err) });
            }.bind(this)
        );

        return when.resolve(result);

    }.bind(this))
    .catch(function(err){ return when.reject(err) });
}

iRabbit.prototype.rpcTopicClient = function( exchangeName, responceFunc, options ){

    assert.equal(typeof (exchangeName), 'string',    "exchangeName string expected");
    // assert.equal(typeof (responceFunc), 'function',    "responceFunc function expected");

    // logCalls.info('iRabbit rpcTopicClient', exchangeName);

    if( typeof(responceFunc) == 'undefined' ||
        responceFunc == false
    ) responceFunc = function( message ){};

    var topicInitOptions = (options && typeof options.initTopic != 'undefined') ? _.extend({},options.initTopic) : {};
    var expiredOptions = (options && typeof options.expired != 'undefined') ? _.extend({},options.expired) : {};
    var callbackQueueOptions = (options && typeof options.initCallbackQueue != 'undefined') ? _.extend({},options.initCallbackQueue) : {};
    var callbackQueueConsumeOptions = (options && typeof options.consumeCallback != 'undefined') ? _.extend({},options.consumeCallback) : {};
    var sendOptions = (options && typeof options.send != 'undefined') ? _.extend({},options.send) : {};

    var hashCode = 'prcTopicClient' + exchangeName;

    if( typeof( this._enity[ hashCode ] ) == 'undefined' || !this._enity[ hashCode ] ){
        var deferred = when.defer();
        this._enity[hashCode] = deferred.promise;
        this._enity[hashCode].then(function( client ){
            this._enity[hashCode] = client;
        }.bind(this));

        // gen callback queue name
        if( typeof(callbackQueueOptions.name)=='undefined' ){
            var callbackQueueName = '';
        } else {
            var callbackQueueName = callbackQueueOptions.name;
        }
        // subscribe callback queue
        return this.subscribeQueue(callbackQueueName, {init:callbackQueueOptions, consume:callbackQueueConsumeOptions} )
        // init exchange
        .then( function callbackQueueSubscribed( subscribeCallbackQueueResult ){

            return this.initTopic(exchangeName, topicInitOptions)
            .then( function( subscribeExchange ){

                // deadletter begin
                    /*// Клиент безусловно создает ексченж для deadletter
                    if( typeof(expiredOptions.deadLetterExchange) == 'undefined' )
                        expiredOptions.deadLetterExchange = this.getDefaultDeadletterExchange();
                    // this.initTopic( expiredOptions.deadLetterExchange );
                    console.log('-- subscribeTopic',expiredOptions.deadLetterExchange, expiredOptions.deadLetterExchange);
                    this.subscribeTopic( expiredOptions.deadLetterExchange, expiredOptions.deadLetterExchange )
                    .then(function( result ){
                    console.log('-- bind event',result.eventName)
                        // add event listener for message
                        _addListener.bind(this)(
                            result.eventName,
                            function(incMsg){
                                console.log('expired message: ',incMsg.message);
                            }.bind(this)
                        );

                        return when.resolve(result);

                    }.bind(this))
                    // .catch(function(err){ return when.reject(err) })
                    ;*/
                // deadletter end

                deferred.resolve( new RpcTopicClient( this, subscribeExchange, subscribeCallbackQueueResult.queue, sendOptions, expiredOptions.deadLetterExchange ) );

                _addListener.bind(this)(
                    subscribeCallbackQueueResult.queue.queue+':message',
                    function(message){
                        responceFunc(message);
                        _received.bind( this._enity[hashCode] )( message );
                    }.bind(this)
                );

                return this._enity[ hashCode ];
            }.bind(this) )
            .catch( function(err){ return when.reject(err); } );
        }.bind(this))
        .catch( function(err){ return when.reject(err); } );
    } else {
        // Вернуть промис зарезовленный как клиент
        return when.resolve( this._enity[ hashCode ] );
    }

    return when.reject('PRC Topic Client create fail');
}


/**
 * Объект, возвращаемый методом iRabbit.rpcQueueClient
 * @param {object} iRabbitInst   instance of iRabbit
 * @param {object} serverQueue   amqplib-queue of rpcQueueServer incuming queue
 * @param {object} callbackQueue amqplib-queue of prcQueueClient callback queue
 */
function RpcQueueClient( iRabbitInst, serverQueue, callbackQueue, sendOptions ){
    this._parent = iRabbitInst;
    this.serverQueue = serverQueue;
    this.callbackQueue = callbackQueue;
    this._subscribedDeadletter = {}; //массив признаков на какие routingKey клиент подписан в рамках deadletterExchange

    this.buffer = [];
    this.sendProcess = false;

    this.sendOptions = typeof(sendOptions)!='undefined' ? sendOptions : {} ;
    this.sendOptions.replyTo = callbackQueue.queue;

    this.correlations = {};
    this.expiredTimers = {};

    // ИМенно .on  а не _addListener - этот слушатель не пользовательский а системный
    this.on(
        callbackQueue.queue+':message',
        function( incMsg ){
            this.emit('receive', incMsg);
        }.bind(this)
    );

    EventEmitter.call(this);
}

util.inherits(RpcQueueClient, EventEmitter);

RpcQueueClient.prototype.send = function( message, options ){
    var corrId = _generateUuid();

    this.correlations[ corrId ] = when.defer();

    var optionsLoc = _.extend(
        this.sendOptions,
        options,
        { correlationId : corrId }
    );
    //Check - sendQueue options
    return this._parent.sendQueue( this.serverQueue.queue, message, {send:optionsLoc} )
    .then(function( result ){

        if( typeof(optionsLoc.expiration)!='undefined' )
            _setExpirationTimer.bind(this)(corrId,optionsLoc.expiration);

        return this.correlations[ corrId ].promise;

    }.bind(this))
    .catch( function(err){ return when.reject( err );});

    return this.correlations[ corrId ].promise;
}


/**
 * RpcTopicClient - subobject for RPC topic client case
 * @param {object} iRabbitInst   instance of iRabbit
 * @param {object} serverQueue   amqplib-queue of rpcQueueServer incuming queue
 * @param {object} callbackQueue amqplib-queue of prcQueueClient callback queue
 */
function RpcTopicClient( iRabbitInst, serverExchange, callbackQueue, sendOptions, deadletterExchangeName ){
    this._parent = iRabbitInst;
    this.serverExchange = serverExchange;
    this.callbackQueue = callbackQueue;
    this._subscribedDeadletter = {}; //массив признаков на какие routingKey клиент подписан в рамках deadletterExchange
    this._deadletterExchangeName = deadletterExchangeName;

    this.sendOptions = typeof(sendOptions)!='undefined' ? sendOptions : {} ;
    this.sendOptions.replyTo = callbackQueue.queue;

    this.correlations = {};
    this.expiredTimers = {};

    // ИМенно .on  а не _addListener - этот слушатель не пользовательский а системный
    this.on(
        serverExchange.exchange + ':message',
        function( incMsg ){
            this.emit('receive', incMsg);
        }.bind(this)
    );

    EventEmitter.call(this);
}

util.inherits(RpcTopicClient, EventEmitter);

RpcTopicClient.prototype.send = function( routingKey, message, options ){
    var corrId = _generateUuid();

    this.correlations[ corrId ] = when.defer();
    var optionsLoc = _.extend(
        this.sendOptions,
        options,
        { correlationId : corrId }
    );

    // ВЫставить expiration сообщения по умолчанию
    if( typeof(options)=='undefined' ) options = {};
    if( typeof(options.expiration)=='undefined' ) options.expiration = 30000;

    // Check - sendTopic options
    return this._parent.sendTopic( this.serverExchange.exchange, routingKey , message, {send:optionsLoc} )
    .then(function( result ){
        // console.log(' --- send result', result, corrId);
        if( typeof(optionsLoc.expiration)!='undefined' )
            _setExpirationTimer.bind(this)(corrId,optionsLoc.expiration);

        return this.correlations[ corrId ].promise;
    }.bind(this))
    .catch( function(err){ return when.reject( err );});
}

/**
 * Вспомогательные ф-ии
 */
/**
 * Help function - processing RPC model for Queue and Topic RPCServers
 * @param  {[type]} incMsg [description]
 * @return {[type]}        [description]
 */

function _processRPC( incMsg, eventFunc, queueResponseOptions ){
    if(
        typeof(incMsg.messageObj.properties)=='undefined' ||
        typeof(incMsg.messageObj.properties.replyTo)=='undefined'
    ){
        // NEED LOG SOMEBODY ABOUT NOWHERE SEND RESPONSE
        return console.error('Expected replyTo property in message');
    }

    var rs = eventFunc( incMsg );
    if( typeof(rs) == 'undefined' ){
        //ОУ! внезапно!... похоже вообще ничего не вернули! делаем эхо
        rs = when.resolve( 'echo:'+incMsg.message );
    } else if( typeof( rs.then ) == 'undefined' ){
        //Хм... похоже вернули не промис, ну что ж - сделать промис!
        rs = when.resolve( rs );
    }

    return rs.then(
        function onResolve( responseMessage ){

            if(
                typeof(incMsg.messageObj.properties) != 'undefined' &&
                typeof(incMsg.messageObj.properties.correlationId) != 'undefined'
            ){
                queueResponseOptions.correlationId = incMsg.messageObj.properties.correlationId;
            }

            return this._sendQueue( incMsg.messageObj.properties.replyTo, responseMessage, queueResponseOptions )
            .catch( function(err){
                // console.log('err', err);
                return when.reject(err);
            });
        }.bind(this),
        function onReject( err ){
            // console.log('err:',err);
            return this._sendQueue( incMsg.messageObj.properties.replyTo, err, queueResponseOptions )
            .catch( function(err){ return when.reject(err); });
        }.bind(this)
    )
    .catch(function(err){
        // console.log('errCatch:',err.stack);
        return this._sendQueue( incMsg.messageObj.properties.replyTo, err, queueResponseOptions )
        .catch( function(err){ return when.reject(err); });
        // return when.reject(err);
    });
}

function _packData( object ){
    var res = {
        mime : 'text/plain',
        data : ''
    };

    switch ( typeof object ) {
        case 'object' :{
            try{
                res.data = JSON.stringify( object );
                res.mime = 'application/json';
            } catch (e){
                throw new Error('Failed pack data');
            }
            break;
        }
        case 'string':{
            res.data = object;
        }
        default: {
            res.data = object.toString();
        }
    }

    res.data = new Buffer( res.data );
    return res;
}

function _unpackData( messageObj ){
    var result = false;

    result = messageObj.content.toString();

    switch( messageObj.properties.contentType ){
        case 'application/json':{
            try{
                result = JSON.parse( result );
            } catch ( e ){
                throw new Error('failed unpack data');
            }
            break;
        }
        case 'text/plain':
        default:{
            // result = messageObj.content.toString();
            // result = querystring.unescape( result );
        }
    }

    return result;
}

function makeHash ( obj ) {
    var str = '';
    switch( typeof(obj) ){
        case 'string': str = obj; break;
        case 'object': str = ( JSON.stringify( obj ) ); break;
        case 'undefined': str = ''; break;
    }

    var hash = 0, i, chr, len;

    if (str.length == 0) return hash;

    for (i = 0, len = str.length; i < len; i++) {
        chr   = str.charCodeAt(i);
        hash  = ((hash << 5) - hash) + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

function _received( incMsg ){

    this.emit('receive',incMsg);

    if(
        typeof( incMsg.messageObj.properties )!='undefined' &&
        typeof( incMsg.messageObj.properties.correlationId )!='undefined' &&
        typeof( this.correlations[ incMsg.messageObj.properties.correlationId ] )!='undefined'
    ){
        this.correlations[ incMsg.messageObj.properties.correlationId ].resolve( incMsg );
        delete( this.correlations[ incMsg.messageObj.properties.correlationId ] );

        if( typeof( this.expiredTimers[ incMsg.messageObj.properties.correlationId ] )!='undefined' ){
            clearTimeout( this.expiredTimers[ incMsg.messageObj.properties.correlationId ] );
            delete( this.expiredTimers[ incMsg.messageObj.properties.correlationId ] );
        }
    }
}

function _generateUuid(){
    // return ( parseInt(Math.random()*10000) ).toString();
    return uuid();
}

function _addListener( eventKey, listener ){
    var ekey = 'event'+eventKey;
    // console.log( 'adding listener', eventKey );

    if( typeof(this._enity[ ekey ]) == 'undefined' ){
        this._enity[ ekey ] = listener;
        this.on( eventKey , listener );
        // console.log( '@listening', eventKey );
    } else {
        // console.log( 'listener of "'+eventKey +'" exists', this._enity[ ekey ] );
    }
    return this._enity[ ekey ] ;
}

// expected bind this
function _setExpirationTimer( corrId, timeout ){
    if( typeof(this)=='undefined' ) return false;

    timeout = parseInt(timeout);
    if(!timeout) return false;

    this.expiredTimers[ corrId ] = setTimeout(function(){
        clearTimeout( this.expiredTimers[ corrId ] );
        this.correlations[ corrId ].reject( 'Message timeout - ' + timeout );
        delete( this.correlations[ corrId ], this.expiredTimers[ corrId ] );
    }.bind(this), timeout );

    return this.expiredTimers[ corrId ];
}