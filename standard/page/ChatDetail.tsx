import React from 'react';
import {Clipboard, Keyboard, SafeAreaView, StyleSheet, TouchableWithoutFeedback, View} from 'react-native';
import {HeaderButton} from 'react-navigation-header-buttons';
import Toast from 'react-native-root-toast';
import Listener from 'react-native-general-listener';
import i18n from 'i18n-js';
import * as PageKeys from '../pagekey';
import * as Model from '../model';
import {DateUtil, guid} from '../util';
import {Conversation, Event, Message} from '../typings';
import delegate from '../delegate';

interface ChatDetailProps {
    imId: string
    chatType: number
}

export default class extends React.PureComponent<ChatDetailProps> {
    static navigationOptions = function ({navigation}) {
        const {_title_, _right_} = navigation.state.params;
        return {
            title: _title_,
            headerRight: _right_,
        };
    };

    static defaultProps = {};

    listeners = new Array(5);
    isGroup: boolean;
    pageCount: number;

    constructor(props: ChatDetailProps) {
        super(props);
        this.isGroup = props.chatType === Conversation.ChatType.Group;
        this.pageCount = delegate.component.DetailListView.defaultProps.pageSize;
        this.state = {
            listKey: guid(),
            messages: [],
            keyboardShow: false,
            menuShow: false,
            menuRef: null,
            actionList: [],
        };
    }

    componentDidMount() {
        this._setNaviBar();
        this._registerListener();
    }

    componentWillUnmount() {
        this._unRegisterListener();
    }

    componentDidUpdate(prevProps) {
        if (prevProps.imId !== this.props.imId) {
            this.isGroup = this.props.chatType === Conversation.ChatType.Group;
            this._setNaviBar();
            this._unRegisterListener();
            this._registerListener();
            this.setState({listKey: guid()});
        }
    }

    _registerListener = () => {
        [
            [Event.SendMessage, this._onReceiveMessage.bind(this)],
            [Event.ReceiveMessage, this._onReceiveMessage.bind(this)],
            this.isGroup && [Event.Group, this._setNaviBar.bind(this)],
        ].filter(i => !!i).forEach(([eventType, func], index) => {
            this.listeners[index] = Listener.register(
                [Event.Base, eventType, this.props.imId],
                func
            );
        });
        const index = this.listeners.length;
        this.listeners[index] = Keyboard.addListener(
            'keyboardDidShow',
            this._setKeyboardStatus.bind(this, true)
        );
        this.listeners[index + 1] = Keyboard.addListener(
            'keyboardWillHide',
            this._setKeyboardStatus.bind(this, false)
        );
    };

    _unRegisterListener = () => {
        this.listeners.forEach(listener => listener && listener.remove())
    };

    render() {
        const {imId, chatType} = this.props;
        return (
            <View style={[styles.view, {backgroundColor: delegate.style.viewBackgroundColor}]}>
                <SafeAreaView
                    style={styles.innerview}
                >
                    <TouchableWithoutFeedback
                        disabled={!this.state.keyboardShow}
                        style={styles.touch}
                        onPress={() => this.bottomBar.dismiss()}
                    >
                        {this._renderContent()}
                    </TouchableWithoutFeedback>
                </SafeAreaView>
                <delegate.component.BottomBar
                    ref={ref => this.bottomBar = ref}
                    imId={imId}
                    chatType={chatType}
                    onSendMultiMessage={this._onSendMultiMessage.bind(this, imId, chatType)}
                    onSendMessage={this._onSendMessage.bind(this, imId, chatType)}
                    navigation={this.props.navigation}
                />
                <delegate.component.MessageMenu
                    menuShow={this.state.menuShow}
                    menuRef={this.state.menuRef}
                    onClose={this._onCloseMenu.bind(this)}
                    actionList={this.state.actionList}
                />
            </View>
        );
    }

    _setNaviBar() {
        const {imId} = this.props;
        let title;
        if (this.isGroup) {
            const groupName = delegate.model.Group.getName(imId, false) || i18n.t('IMCommonChatTypeGroup');
            title = groupName + ' (' + delegate.model.Group.getMembers(imId).length + ')';
        } else {
            title = delegate.user.getUser(imId).name;
        }
        this.props.navigation.setParams({
            _title_: title,
            _right_: this._renderRightElement(),
        });
    }

    _renderContent() {
        return (
            <View style={styles.container}>
                <delegate.component.DetailListView
                    key={this.state.listKey}
                    ref={ref => this.list = ref}
                    style={styles.fixedList}
                    renderItem={this._renderItem.bind(this)}
                    onLoadPage={this._refresh.bind(this)}
                />
                <View style={styles.flexList} />
            </View>
        );
    }

    _renderRightElement() {
        return (
            <HeaderButton
                title={i18n.t('IMPageChatDetailSetting')}
                onPress={() => {
                    this.props.navigation.navigate({
                        routeName: PageKeys.ChatSetting,
                        params: {
                            imId: this.props.imId,
                            chatType: this.props.chatType,
                        },
                    });
                }}
            />
        );
    }

    _setKeyboardStatus(status) {
        this.setState({
            keyboardShow: status,
        }, () => {
            if (status) {
                this.list.scrollToTop();
            }
        });
    }

    protected async _refresh(oldData) {
        const isFirst = !oldData || oldData.length <= 0;
        const lastMessage = isFirst ? undefined : this.lastMessage;
        const loadPromise = delegate.im.conversation.loadMessage({
            imId: this.props.imId,
            chatType: this.props.chatType,
            lastMessage: lastMessage,
            count: this.pageCount,
        });
        const markPromise = this._markAllRead();
        let [result] = await Promise.all([loadPromise, markPromise]);
        result = result
            .map(item => Model.Action.Parse.get(undefined, item, item))
            .sort((a, b) => a.timestamp >= b.timestamp ? -1 : 1);
        if (result && result.length > 0) {
            this.lastMessage = result[result.length - 1];
        }
        return {
            data: result,
            isEnd: result.length < this.pageCount,
        };
    }

    _insertMessageToList(message) {
        console.log(message);
        const messages = Array.isArray(message) ? message : [message];
        this.list.insert(messages);
    }

    _onReceiveMessage(message) {
        this._insertMessageToList(message);
        this._markAllRead()
    }

    _onSendMultiMessage(imId, chatType, {type, bodies}) {
        const messages = bodies.map(body => this._generateMessage(type, body));
        this._sendMessage(imId, chatType, messages, delegate.model.Message.sendMultiMessage);
    }

    _onSendMessage(imId, chatType, {type, body, ...other}) {
        const message = this._generateMessage(type, body, other);
        this._sendMessage(imId, chatType, message, delegate.model.Message.sendMessage);
    }

    _sendMessage(imId, chatType, message, sendFunc) {
        const isCurrent = this.props.imId === imId;
        sendFunc(imId, chatType, message)
            .then(() => {
                if (isCurrent) {
                    this._markAllRead();
                } else {
                    Toast.show(i18n.t('IMToastSuccess', {
                        action: i18n.t('IMCommonSendMessage')
                    }));
                }
            })
            .catch(() => {
                Toast.show(i18n.t('IMToastError', {
                    action: i18n.t('IMCommonSendMessage')
                }));
            });
    }

    _onShowMenu(params) {
        const {ref, isSender, message} = params;
        const messageType = message.type;
        const actionList = [];
        const interval = (new Date().getTime() - message.timestamp) / 1000;
        const canRecall = interval < 5 * 60;
        if (messageType === delegate.config.messageType.text) {
            actionList.push({title: '复制', action: this._onCopy.bind(this, message)});
            this.isGroup && !isSender && actionList.push({
                title: '引用',
                action: this._onQuote.bind(this, message)
            });
        }
        actionList.push({title: '转发', action: this._onForward.bind(this, message)});
        if (isSender && canRecall) {
            actionList.push({title: '撤回', action: this._onRecall.bind(this, message)});
        }
        this.setState({
            menuShow: true,
            menuRef: ref,
            actionList: actionList,
        });
    }

    _onCloseMenu() {
        this.setState({menuShow: false});
    }

    _onCopy(message) {
        const text = message.data.text;
        Clipboard.setString(text);
    }

    _onForward(message) {
        this.props.navigation.navigate({
            routeName: PageKeys.ChooseConversation,
            params: {
                title: i18n.t('IMPageChooseConversationTitle'),
                onSelectData: this._onSelectConversation.bind(this, message),
                excludedIds: [this.props.imId],
            },
        });
    }

    async _onRecall(message) {
        const {imId, chatType} = this.props;
        await delegate.model.External.onRecallMessage(
            imId,
            chatType,
            delegate.user.getMine().userId,
            message
        );
        await delegate.im.conversation.recallMessage({imId, chatType, message});
    }

    _onQuote(item) {
        this.bottomBar.changeInputText(item.from, item.data.text);
    }

    _onSelectConversation(message, conversations) {
        this._onSendMessage(
            conversations[0].imId,
            conversations[0].chatType,
            {...message, body: message.data}
        );
    }

    protected async _markAllRead() {
        const {imId, chatType} = this.props;
        return await delegate.model.Conversation.markReadStatus(imId, chatType, true);
    }

    _renderItem({item}, messageList) {
        const isMe = item.from === delegate.user.getMine().userId;
        const position = item.data.isSystem ? 0 : isMe ? 1 : -1;
        if (item.data.isSystem && item.data.text.length <= 0) {
            item.data.text = DateUtil.showDateTime(item.timestamp, true);
        }
        return (
            <delegate.component.BaseMessage
                imId={this.props.imId}
                chatType={this.props.chatType}
                position={position}
                message={item}
                messages={messageList}
                onShowMenu={this._onShowMenu.bind(this)}
                navigation={this.props.navigation}
            />
        );
    }

    _generateMessage(type, body, others = {}) {
        return {
            conversationId: this.props.imId,
            messageId: undefined,
            innerId: guid(),
            status: Message.Status.Pending,
            type: type,
            from: delegate.user.getMine().userId,
            to: this.props.imId,
            localTime: new Date().getTime(),
            timestamp: new Date().getTime(),
            data: body,
            ...others,
        };
    }
}

const styles = StyleSheet.create({
    view: {
        flex: 1,
    },
    innerview: {
        flex: 1,
    },
    fixedList: {
        flex: 0,
    },
    flexList: {
        flex: 10000,
    },
    touch: {
        flex: 1,
    },
    container: {
        flex: 1,
    },
});