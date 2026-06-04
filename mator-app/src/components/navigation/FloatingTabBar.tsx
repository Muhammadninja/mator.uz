// src/components/navigation/FloatingTabBar.tsx
import { BottomTabBarProps } from '@react-navigation/bottom-tabs';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
    interpolateColor,
    useAnimatedStyle,
    useSharedValue,
    withSpring,
    withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const ICONS: Record<string, string> = {
  index:   '🏠',
  chat:    '🤖',
  garage:  '🚗',
  orders:  '🛒',
  profile: '👤',
};

interface TabItemProps {
  label: string;
  icon: string;
  isFocused: boolean;
  onPress: () => void;
  onLongPress: () => void;
}

function TabItem({ label, icon, isFocused, onPress, onLongPress }: TabItemProps) {
  const scale = useSharedValue(1);
  const focusProgress = useSharedValue(isFocused ? 1 : 0);

  if (isFocused && focusProgress.value !== 1) {
    focusProgress.value = withTiming(1, { duration: 200 });
  } else if (!isFocused && focusProgress.value !== 0) {
    focusProgress.value = withTiming(0, { duration: 200 });
  }

  const containerStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    backgroundColor: interpolateColor(
      focusProgress.value,
      [0, 1],
      ['transparent', '#E63946'],
    ),
  }));

  const labelStyle = useAnimatedStyle(() => ({
    opacity: withTiming(isFocused ? 1 : 0, { duration: 150 }),
    maxWidth: withSpring(isFocused ? 80 : 0, { damping: 15, stiffness: 120 }),
  }));

  return (
    <Pressable
      onPress={() => {
        scale.value = withSpring(0.88, { damping: 10, stiffness: 300 }, () => {
          scale.value = withSpring(1, { damping: 12, stiffness: 200 });
        });
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      onLongPress={onLongPress}
      style={styles.tabPressable}
    >
      <Animated.View style={[styles.tabPill, containerStyle]}>
        <Text style={styles.icon}>{icon}</Text>
        <Animated.Text
          style={[styles.label, labelStyle]}
          numberOfLines={1}
        >
          {label}
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}

export default function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.wrapper, { bottom: insets.bottom + 16 }]}>
      <View style={styles.bar}>
        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label = (options.title ?? route.name) as string;
          const isFocused = state.index === index;

          const onPress = () => {
            const event = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          const onLongPress = () => {
            navigation.emit({ type: 'tabLongPress', target: route.key });
          };

          return (
            <TabItem
              key={route.key}
              label={label}
              icon={ICONS[route.name] ?? '●'}
              isFocused={isFocused}
              onPress={onPress}
              onLongPress={onLongPress}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 20,
    right: 20,
    alignItems: 'center',
    pointerEvents: 'box-none',
  },
  bar: {
    flexDirection: 'row',
    backgroundColor: '#1A1A1A',
    borderRadius: 32,
    paddingVertical: 8,
    paddingHorizontal: 8,
    gap: 4,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.25,
        shadowRadius: 16,
      },
      android: { elevation: 12 },
    }),
  },
  tabPressable: {
    flex: 1,
    alignItems: 'center',
  },
  tabPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 24,
    paddingVertical: 10,
    paddingHorizontal: 14,
    gap: 6,
    overflow: 'hidden',
  },
  icon: {
    fontSize: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#FFFFFF',
    overflow: 'hidden',
  },
});
