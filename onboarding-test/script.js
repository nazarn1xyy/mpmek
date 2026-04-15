document.addEventListener('DOMContentLoaded', () => {
    const slider = document.getElementById('slider');
    const dots = document.querySelectorAll('.dot');
    const nextBtn = document.getElementById('nextBtn');
    const skipBtn = document.getElementById('skipBtn');
    const slidesCount = 4;
    
    let currentSlide = 0;

    function updateSlider() {
        // Move slider
        slider.style.transform = `translateX(-${currentSlide * 25}%)`;
        
        // Update dots
        dots.forEach((dot, index) => {
            if (index === currentSlide) {
                dot.classList.add('active');
            } else {
                dot.classList.remove('active');
            }
        });

        // Update buttons
        if (currentSlide === slidesCount - 1) {
            nextBtn.textContent = 'Почати';
            skipBtn.style.opacity = '0';
            skipBtn.style.pointerEvents = 'none';
        } else {
            nextBtn.textContent = 'Далі';
            skipBtn.style.opacity = '1';
            skipBtn.style.pointerEvents = 'auto';
        }
    }

    nextBtn.addEventListener('click', () => {
        if (currentSlide < slidesCount - 1) {
            currentSlide++;
            updateSlider();
        } else {
            // Reached the end
            alert('Тут користувач перейде до вибору групи в основному додатку.');
            // window.location.href = '../index.html';
        }
    });

    skipBtn.addEventListener('click', () => {
        // Go straight to end
        currentSlide = slidesCount - 1;
        updateSlider();
    });

    // Touch swipe support
    let touchStartX = 0;
    let touchEndX = 0;

    slider.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
    }, { passive: true });

    slider.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].clientX;
        handleSwipe();
    }, { passive: true });

    function handleSwipe() {
        const threshold = 50; // min distance for swipe
        if (touchStartX - touchEndX > threshold && currentSlide < slidesCount - 1) {
            // Swipe Left
            currentSlide++;
            updateSlider();
        }
        if (touchEndX - touchStartX > threshold && currentSlide > 0) {
            // Swipe Right
            currentSlide--;
            updateSlider();
        }
    }
});
