// app/welcome.tsx — Animated brand welcome / onboarding screen
import { router } from 'expo-router';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
    Easing,
    useAnimatedStyle,
    useSharedValue,
    withDelay,
    withSpring,
    withTiming
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function WelcomeScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();

  const logoOpacity = useSharedValue(0);
  const logoScale = useSharedValue(0.7);
  const taglineOpacity = useSharedValue(0);
  const taglineY = useSharedValue(20);
  const ctaOpacity = useSharedValue(0);
  const ctaY = useSharedValue(30);

  useEffect(() => {
    logoOpacity.value = withTiming(1, { duration: 700, easing: Easing.out(Easing.exp) });
    logoScale.value = withSpring(1, { damping: 12, stiffness: 90 });

    taglineOpacity.value = withDelay(500, withTiming(1, { duration: 600 }));
    taglineY.value = withDelay(500, withTiming(0, { duration: 600, easing: Easing.out(Easing.quad) }));

    ctaOpacity.value = withDelay(1000, withTiming(1, { duration: 600 }));
    ctaY.value = withDelay(1000, withTiming(0, { duration: 600, easing: Easing.out(Easing.quad) }));
  }, []);

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: taglineOpacity.value,
    transform: [{ translateY: taglineY.value }],
  }));

  const ctaStyle = useAnimatedStyle(() => ({
    opacity: ctaOpacity.value,
    transform: [{ translateY: ctaY.value }],
  }));

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom + 32 }]}>
      <Animated.View style={[styles.logoWrapper, logoStyle]}>
        <View style={styles.logoCircle}>
          <Text style={styles.logoText}>M</Text>
        </View>
        <Text style={styles.brand}>MATOR</Text>
      </Animated.View>

      <Animated.Text style={[styles.tagline, taglineStyle]}>
        {t('welcome.tagline')}
      </Animated.Text>

      <Animated.View style={[styles.ctaWrapper, ctaStyle]}>
        <Pressable
          style={({ pressed }) => [styles.ctaButton, pressed && styles.ctaPressed]}
          onPress={() => router.replace('/(tabs)')}
        >
          <Text style={styles.ctaText}>{t('welcome.cta')}</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logoCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#E63946',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  logoText: {
    fontSize: 48,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  brand: {
    fontSize: 36,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 8,
  },
  tagline: {
    fontSize: 16,
    color: '#999999',
    textAlign: 'center',
    lineHeight: 24,
    marginBottom: 64,
  },
  ctaWrapper: {
    position: 'absolute',
    bottom: 80,
    left: 24,
    right: 24,
  },
  ctaButton: {
    backgroundColor: '#E63946',
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
  },
  ctaPressed: {
    opacity: 0.85,
  },
  ctaText: {
    fontSize: 17,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
});
